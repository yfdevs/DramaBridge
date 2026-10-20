/* oxlint-disable no-undef, typescript/no-require-imports */
const http = require("node:http");
const https = require("node:https");

const httpProxy = process.env.DRAMABRIDGE_HTTP_PROXY;
const httpsProxy = process.env.DRAMABRIDGE_HTTPS_PROXY;
const noProxy = process.env.DRAMABRIDGE_NO_PROXY;

if (httpProxy || httpsProxy) {
  const proxyEnv = {};
  if (httpProxy) proxyEnv.HTTP_PROXY = httpProxy;
  if (httpsProxy) proxyEnv.HTTPS_PROXY = httpsProxy;
  if (noProxy) proxyEnv.NO_PROXY = noProxy;

  // Node 24 supports proxyEnv natively. Replacing the global agents lets
  // electron-builder use that implementation without loading its incompatible
  // https-proxy-agent 5 fallback.
  http.globalAgent = new http.Agent({ proxyEnv });
  https.globalAgent = new https.Agent({ proxyEnv });
}
