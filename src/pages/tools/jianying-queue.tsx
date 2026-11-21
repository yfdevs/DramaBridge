import { Search, X } from "@mynaui/icons-react";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ListFilterMenu } from "@/components/list-filter-menu";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { jianying, type JianyingQueueState } from "@/platforms/jianying/service";

const labels = {waiting:"等待中",running:"处理中",success:"已完成",failed:"处理失败",cancelled:"已停止"};
export function JianyingQueue({queue,pending,action}: {
  queue: JianyingQueueState; pending: boolean; action: (work:()=>Promise<unknown>)=>Promise<void>;
}) {
  const [keyword,setKeyword]=useState("");
  const [filter,setFilter]=useState("");
  const tasks=queue.tasks.filter(task=>(!filter || task.status===filter) && task.name.toLowerCase().includes(keyword.trim().toLowerCase()));
  return <section aria-label="剪映任务列表" className="min-w-0 space-y-3">
    <div className="flex flex-wrap items-center gap-2">
      <InputGroup className="h-7 w-full min-w-0 basis-full rounded-md sm:w-auto sm:min-w-48 sm:flex-1 sm:basis-auto sm:max-w-80">
        <InputGroupAddon><Search aria-hidden="true" className="size-3.5" /></InputGroupAddon>
        <InputGroupInput aria-label="搜索剧名" placeholder="搜索剧名" value={keyword} onChange={event=>setKeyword(event.target.value)} className="text-xs" />
        {keyword && <InputGroupAddon align="inline-end"><InputGroupButton aria-label="清空搜索" size="icon-xs" onClick={()=>setKeyword("")}><X aria-hidden="true" className="size-3.5" /></InputGroupButton></InputGroupAddon>}
      </InputGroup>
      <ListFilterMenu label="筛选任务状态" showLabel={false} groups={[{
        key:"status", label:"任务状态", value:filter, defaultValue:"", onChange:setFilter,
        options:[{value:"",label:"全部状态"},...Object.entries(labels).map(([value,label])=>({value,label}))],
      }]} />
      <span className="ml-auto text-xs tabular-nums text-muted-foreground">共 {tasks.length} 个任务</span>
    </div>
    <Table>
      <TableHeader className="bg-muted/30"><TableRow><TableHead className="pl-3">剧名</TableHead><TableHead className="w-24">状态</TableHead><TableHead>当前进度</TableHead><TableHead className="w-32 pr-3 text-left">操作</TableHead></TableRow></TableHeader>
      <TableBody>
        {tasks.map(task=><TableRow key={task.id}>
          <TableCell className="max-w-64 pl-3"><div className="truncate font-medium" title={task.name}>{task.name}</div><div className="mt-1 truncate text-muted-foreground" title={task.source}>{task.source}</div></TableCell>
          <TableCell><span className={task.status==="failed" ? "text-destructive" : task.status==="running" ? "font-medium" : "text-muted-foreground"}>{labels[task.status]}</span></TableCell>
          <TableCell className="max-w-80"><p className="truncate" title={task.message}>{task.message}</p><p className="mt-1 text-muted-foreground">{task.settings.minSeconds}–{task.settings.maxSeconds} 秒 · 视频 {task.settings.videoBlocksMin}–{task.settings.videoBlocksMax} · 音频 {task.settings.audioBlocksMin}–{task.settings.audioBlocksMax}</p></TableCell>
          <TableCell className="pr-3"><div className="flex gap-1">
            {task.output && <Button size="sm" variant="ghost" disabled={pending} onClick={()=>void action(()=>jianying.openTaskOutput(task.id))}>结果</Button>}
            {["failed","cancelled"].includes(task.status) && <Button size="sm" variant="ghost" disabled={pending} onClick={()=>void action(()=>jianying.retryTask(task.id))}>重试</Button>}
            {task.status!=="running" && <Button size="sm" variant="ghost" disabled={pending} onClick={()=>void action(()=>jianying.removeTask(task.id))}>移除</Button>}
          </div></TableCell>
        </TableRow>)}
        {!tasks.length && <TableRow><TableCell colSpan={4} className="h-28 text-center text-muted-foreground">{queue.tasks.length ? "没有匹配的任务" : "暂无任务，点击添加任务选择视频文件夹"}</TableCell></TableRow>}
      </TableBody>
    </Table>
    {!queue.running && queue.tasks.some(task=>task.status==="waiting") && <p className="text-xs text-muted-foreground">队列已暂停，等待启动</p>}
  </section>;
}
