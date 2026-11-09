import { preparePythonInstaller, type BootstrapDownload } from "./python-bootstrap.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, cp, mkdir, rm, statfs } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type YoutubeSettings = { proxy: string; paused: boolean };
export type YoutubeRuntimeStatus = {
  running: boolean;
  starting: boolean;
  installing: boolean;
  pid?: number;
  error?: string;
  installStage?: string;
};
export type YoutubeRuntimeOptions = {
  sourceDirectory: string;
  workingDirectory: string;
  pythonExecutable: string;
  mediaDirectories: string[];
  settings: YoutubeSettings;
  netdisk: (request: { path: string; body: Json }) => Promise<Json>;
  saveSettings: (settings: Partial<YoutubeSettings>) => void;
  log: (message: string) => void;
  onExit?: () => void;
  download?: BootstrapDownload;
};

export function allowedYoutubeRequest(route: string, post: boolean) {
  if (!post)
    return /^\/api\/(?:tasks(?:\/[a-f0-9-]+)?|accounts|oauth\/status|status|environment)$/.test(
      route,
    );
  return /^\/api\/(?:tasks(?:\/[a-f0-9-]+\/(?:retry|cancel|pause|resume|delete))?|accounts(?:\/(?:default|[a-f0-9]{32})(?:\/delete)?)?|oauth\/(?:start|cancel|complete|test)|settings|netdisk\/start)$/.test(
    route,
  );
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const pythonInVenv = (root: string) =>
  path.join(root, "python-env", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

export class YoutubePythonRuntime {
  private child?: ChildProcessWithoutNullStreams;
  private installer?: ChildProcessWithoutNullStreams;
  private installationAbort?: AbortController;
  private url?: string;
  private token = "";
  private state: YoutubeRuntimeStatus = { running: false, starting: false, installing: false };
  private starting?: Promise<void>;

  status(): YoutubeRuntimeStatus {
    return { ...this.state };
  }

  private environment(options: YoutubeRuntimeOptions): NodeJS.ProcessEnv {
    return {
      ...process.env,
      PATH: [...options.mediaDirectories, process.env.PATH ?? ""].join(path.delimiter),
      PYTHONIOENCODING: "utf-8",
      PYTHONUNBUFFERED: "1",
      PYTHONDONTWRITEBYTECODE: "1",
    };
  }

  async python(options: YoutubeRuntimeOptions) {
    const managed = pythonInVenv(options.workingDirectory);
    return await access(managed).then(
      () => managed,
      () => {
        if (!options.pythonExecutable.trim()) throw new Error("请先点击“安装依赖”准备 Python 环境");
        return options.pythonExecutable;
      },
    );
  }

  async inspectEnvironment(options: YoutubeRuntimeOptions): Promise<Json> {
    if (this.state.installing) throw new Error("请等待依赖准备完成后检查环境");
    if (this.state.running) return this.request("/api/environment");
    const executable = await this.python(options);
    return new Promise<Json>((resolve, reject) => {
      const child = spawn(
        executable,
        ["-u", "-B", path.join(options.sourceDirectory, "app", "desktop_bridge.py"), "--check"],
        {
          env: this.environment(options),
          windowsHide: true,
          stdio: "pipe",
        },
      );
      let result: Json | undefined;
      let error = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("环境检查超时，请确认 Python 路径"));
      }, 10000);
      child.once("error", (cause) => {
        clearTimeout(timer);
        reject(cause);
      });
      createInterface({ input: child.stdout }).on("line", (line) => {
        try {
          const data = object(JSON.parse(line));
          if (data.kind === "environment") result = data.value as Json;
        } catch {
          /* Only structured environment output is consumed. */
        }
      });
      child.stderr.on("data", (chunk) => {
        error = (error + String(chunk)).slice(-2000);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0 && result !== undefined) resolve(result);
        else reject(new Error(error || "Python 环境检查失败，请确认启动文件有效"));
      });
      child.stdin.end();
    });
  }

  start(options: YoutubeRuntimeOptions): Promise<void> {
    if (this.starting) return this.starting;
    if (this.child) return Promise.resolve();
    if (this.state.installing) return Promise.reject(new Error("请等待 Python 依赖安装完成"));
    this.starting = this.launch(options).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async launch(options: YoutubeRuntimeOptions) {
    this.state = { running: false, starting: true, installing: false };
    try {
      await mkdir(options.workingDirectory, { recursive: true });
      await cp(
        path.join(options.sourceDirectory, "app"),
        path.join(options.workingDirectory, "app"),
        {
          recursive: true,
          force: true,
          filter: (name) => !name.includes("__pycache__") && !name.endsWith(".pyc"),
        },
      );
      this.token = randomBytes(32).toString("hex");
      const child = spawn(
        await this.python(options),
        ["-u", "-B", path.join(options.workingDirectory, "app", "desktop_bridge.py")],
        {
          cwd: options.workingDirectory,
          env: this.environment(options),
          windowsHide: true,
          stdio: "pipe",
        },
      );
      this.child = child;
      child.stdin.on("error", () => {
        /* The exit/error handlers own lifecycle failures. */
      });
      await new Promise<void>((resolve, reject) => {
        let ready = false;
        const timer = setTimeout(
          () => reject(new Error("YouTube Python 服务启动超时，请检查 Python 路径和日志")),
          20_000,
        );
        const fail = (error: Error) => {
          clearTimeout(timer);
          if (!ready) reject(error);
        };
        child.once("error", fail);
        child.once("exit", (code) => {
          clearTimeout(timer);
          if (this.child === child) {
            this.child = undefined;
            this.url = undefined;
            this.state.running = false;
            options.onExit?.();
          }
          if (!ready) fail(new Error(`YouTube Python 服务退出（${code ?? "signal"}），请查看日志`));
        });
        createInterface({ input: child.stderr }).on("line", (line) =>
          options.log(line.slice(0, 4000)),
        );
        createInterface({ input: child.stdout }).on("line", (line) => {
          let data: Record<string, unknown>;
          try {
            data = object(JSON.parse(line));
          } catch {
            options.log(line.slice(0, 4000));
            return;
          }
          if (
            data.kind === "ready" &&
            Number.isInteger(data.port) &&
            Number(data.port) > 0 &&
            Number(data.port) <= 65535
          ) {
            this.url = `http://127.0.0.1:${Number(data.port)}`;
            this.state = { running: true, starting: false, installing: false, pid: child.pid };
            ready = true;
            clearTimeout(timer);
            resolve();
          } else if (data.kind === "error")
            fail(new Error(typeof data.error === "string" ? data.error : "Python 服务启动失败"));
          else if (
            (data.kind === "netdisk" || data.kind === "settings") &&
            typeof data.id === "string"
          ) {
            void this.respond(child, options, data);
          }
        });
        child.stdin.write(
          JSON.stringify({
            root: options.workingDirectory,
            token: this.token,
            settings: options.settings,
          }) + "\n",
        );
      });
    } catch (error) {
      this.state = { running: false, starting: false, installing: false, error: message(error) };
      this.child?.stdin.end();
      this.child?.kill();
      this.child = undefined;
      throw error;
    }
  }

  private async respond(
    child: ChildProcessWithoutNullStreams,
    options: YoutubeRuntimeOptions,
    data: Record<string, unknown>,
  ) {
    try {
      const payload = object(data.payload);
      let value: Json = null;
      if (data.kind === "netdisk") {
        if (
          typeof payload.path !== "string" ||
          !/^\/baidu-netdisk\/(?:status|start|downloads(?:\/[\w-]+(?:\/(?:retry|pause|resume))?)?)(?:\?wait=true)?$/.test(
            payload.path,
          )
        )
          throw new Error("无效的百度下载桥接请求");
        value = await options.netdisk({ path: payload.path, body: (payload.body ?? null) as Json });
      } else {
        const settings: Partial<YoutubeSettings> = {};
        if (typeof payload.proxy === "string") settings.proxy = payload.proxy;
        if (typeof payload.paused === "boolean") settings.paused = payload.paused;
        options.saveSettings(settings);
      }
      if (this.child === child && child.stdin.writable)
        child.stdin.write(JSON.stringify({ id: data.id, value }) + "\n");
    } catch (error) {
      if (this.child === child && child.stdin.writable)
        child.stdin.write(JSON.stringify({ id: data.id, error: message(error) }) + "\n");
    }
  }

  async request<T = Json>(route: string, body?: Json): Promise<T> {
    if (!allowedYoutubeRequest(route, body !== undefined)) throw new Error("不支持的 YouTube 请求");
    if (!this.url || !this.child || !this.state.running) throw new Error("请先启动 YouTube 服务");
    const response = await fetch(this.url + route, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", "X-DramaBridge-Token": this.token },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(40_000),
    });
    const result: unknown = await response.json();
    if (!response.ok)
      throw new Error(
        typeof object(result).error === "string"
          ? String(object(result).error)
          : `YouTube 服务 HTTP ${response.status}`,
      );
    return result as T;
  }

  async stop() {
    if (this.starting) await this.starting.catch(() => undefined);
    const child = this.child;
    if (!child) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.stdin.end(JSON.stringify({ kind: "stop" }) + "\n");
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      exited,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 25_000);
      }),
    ]);
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(resolve, 5000);
        child.once("exit", () => {
          clearTimeout(killTimer);
          resolve();
        });
      });
    }
    if (child.exitCode === null && child.signalCode === null)
      throw new Error("YouTube 进程未能退出，请检查正在处理的任务");
    this.child = undefined;
    this.url = undefined;
    this.state = { running: false, starting: false, installing: false };
  }

  dispose() {
    this.child?.stdin.end(JSON.stringify({ kind: "stop" }) + "\n");
    this.installationAbort?.abort(new Error("环境安装已取消"));
    this.installer?.kill();
  }

  async installDependencies(options: YoutubeRuntimeOptions) {
    if (this.child || this.state.installing || this.starting)
      throw new Error("请先停止 YouTube 服务，再准备 Python 环境");
    this.state = { running: false, starting: false, installing: true };
    const abort = new AbortController();
    this.installationAbort = abort;
    let diskTimer: ReturnType<typeof setInterval> | undefined;
    const installEnv: NodeJS.ProcessEnv = {
      ...this.environment(options),
      UV_PYTHON_INSTALL_DIR: path.join(options.workingDirectory, "python-runtime"),
      UV_CACHE_DIR: path.join(options.workingDirectory, "python-cache"),
      UV_NO_CONFIG: "1",
      UV_PYTHON_INSTALL_BIN: "0",
      UV_PYTHON_INSTALL_REGISTRY: "0",
      PIP_DISABLE_PIP_VERSION_CHECK: "1",
      PIP_NO_CACHE_DIR: "1",
    };
    if (options.settings.proxy)
      for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"])
        installEnv[name] = options.settings.proxy;
    for (const name of [
      "PYTHONHOME",
      "PYTHONPATH",
      "VIRTUAL_ENV",
      "UV_PYTHON",
      "UV_PROJECT_ENVIRONMENT",
    ])
      delete installEnv[name];
    const execute = (stage: string, executable: string, args: string[], timeout = 0) =>
      new Promise<string>((resolve, reject) => {
        abort.signal.throwIfAborted();
        options.log(stage);
        this.state.installStage = stage;
        const child = spawn(executable, args, {
          env: installEnv,
          signal: abort.signal,
          windowsHide: true,
          stdio: "pipe",
        });
        this.installer = child;
        const timer = timeout
          ? setTimeout(() => {
              child.kill();
              reject(new Error(`${stage}超时`));
            }, timeout)
          : undefined;
        let stdout = "";
        const tail: string[] = [];
        child.stdout.on("data", (chunk) => {
          stdout = (stdout + String(chunk)).slice(-65536);
        });
        for (const stream of [child.stdout, child.stderr])
          createInterface({ input: stream }).on("line", (line) => {
            const text = line.slice(0, 4000);
            options.log(text);
            if (text.trim()) {
              tail.push(text);
              if (tail.length > 8) tail.shift();
            }
          });
        child.once("error", (error) => {
          clearTimeout(timer);
          const failure = new Error(`无法启动 Python：${executable}。请检查所选文件是否可用。`);
          Object.assign(failure, { cause: error });
          reject(failure);
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          return code === 0
            ? resolve(stdout)
            : reject(
                new Error(
                  `${stage}失败（${code ?? "signal"}）${tail.length ? "：" + tail.slice(-3).join("；") : "，请查看 YouTube 日志"}`,
                ),
              );
        });
      });
    const networkExecute = async (stage: string, executable: string, args: string[]) => {
      try {
        return await execute(stage, executable, args);
      } catch (error) {
        if (
          abort.signal.aborted ||
          !options.settings.proxy ||
          !/timeout|timed out|certificate|connect|network|download|fetch|http|proxy|网络|下载/i.test(
            message(error),
          )
        )
          throw error;
        options.log("网络连接失败，尝试直连下载");
        for (const name of [
          "HTTPS_PROXY",
          "HTTP_PROXY",
          "https_proxy",
          "http_proxy",
          "ALL_PROXY",
          "all_proxy",
        ])
          delete installEnv[name];
        return execute(stage, executable, args);
      }
    };
    const probe = async (executable: string) => {
      if (!executable.trim()) return null;
      try {
        const result = await execute(
          "检查 Python 版本",
          executable,
          [
            "-c",
            "import sys,json; print(json.dumps({'version': list(sys.version_info[:3]), 'executable': sys.executable}))",
          ],
          10000,
        );
        const python = JSON.parse(result.trim()) as { version: number[]; executable: string };
        if (python.version[0] === 3 && python.version[1] >= 10) return executable;
        options.log(`Python ${python.version.join(".")} 不兼容，将自动安装 Python 3.12`);
      } catch (error) {
        if (abort.signal.aborted) throw error;
        options.log(`Python 不可用，将自动安装 Python 3.12：${message(error)}`);
      }
      return null;
    };
    try {
      await mkdir(options.workingDirectory, { recursive: true });
      const checkSpace = async (minimum: number) => {
        const space = await statfs(options.workingDirectory);
        if (space.bavail * space.bsize < minimum)
          throw new Error("磁盘可用空间不足，请释放空间后再安装");
      };
      await checkSpace(2 * 1024 ** 3);
      diskTimer = setInterval(() => {
        void checkSpace(512 * 1024 ** 2).catch((error) => abort.abort(error));
      }, 2000);
      diskTimer.unref();
      const managed = pythonInVenv(options.workingDirectory);
      const existing = await access(managed).then(
        () => true,
        () => false,
      );
      let python = existing ? await probe(managed) : null;
      const reuse = Boolean(python);
      if (!python && options.pythonExecutable.trim())
        python = await probe(options.pythonExecutable);
      if (!python) {
        const uv = await preparePythonInstaller(
          options.workingDirectory,
          abort.signal,
          (text) => {
            this.state.installStage = text;
            options.log(text);
          },
          options.download,
        );
        await execute("检查 Python 安装工具", uv, ["--version"], 10000);
        await networkExecute("下载 Python 3.12", uv, [
          "python",
          "install",
          "3.12",
          "--no-bin",
          "--no-registry",
        ]);
        python = (
          await execute(
            "定位 Python 3.12",
            uv,
            ["python", "find", "--managed-python", "--no-python-downloads", "3.12"],
            10000,
          )
        ).trim();
        if (!path.isAbsolute(python) || !(await probe(python)))
          throw new Error("自动安装的 Python 无法运行，请重试");
      }
      if (!reuse) {
        if (existing)
          await rm(path.join(options.workingDirectory, "python-env"), {
            recursive: true,
            force: true,
          });
        await execute("创建 Python 环境", python, [
          "-m",
          "venv",
          path.join(options.workingDirectory, "python-env"),
        ]);
      }
      await networkExecute("安装 Python 依赖", managed, [
        "-m",
        "pip",
        "install",
        "--retries",
        "2",
        "--timeout",
        "30",
        "-r",
        path.join(options.sourceDirectory, "requirements", "runtime.txt"),
      ]);
      await execute(
        "验证 Python 依赖",
        managed,
        [
          "-c",
          "import demucs.api, numpy, googleapiclient, google_auth_oauthlib, socks; print('Python dependencies ready')",
        ],
        60000,
      );
      this.state = { running: false, starting: false, installing: false };
    } catch (error) {
      const failure =
        abort.signal.aborted && abort.signal.reason instanceof Error ? abort.signal.reason : error;
      this.state = { running: false, starting: false, installing: false, error: message(failure) };
      throw failure;
    } finally {
      clearInterval(diskTimer);
      this.installer = undefined;
      this.installationAbort = undefined;
      await rm(path.join(options.workingDirectory, "python-cache"), {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      }).catch((error) => options.log(`安装缓存清理失败：${message(error)}`));
    }
  }
}

export { YoutubeWebServer } from "./web-server.js";
