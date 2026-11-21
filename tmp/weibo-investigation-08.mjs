const task=await taskSpace(15);const page=task.page("p1");
const evidence=await page.evaluate(async()=>{
  const r=await fetch('https://api-duanju.weibo.com/creator/album/info?id=24812',{headers:{Authorization:`Bearer ${localStorage.getItem('token')}`},credentials:'include',signal:AbortSignal.timeout(10000)});
  const j=await r.json();if(j.status!==0)throw new Error('Album read failed');
  const d=j.data.detail_info;
  return {detail_info:{id:d.id,name:d.name,pub_uid:d.pub_uid,status:d.status,total_num:d.total_num},video_list:j.data.video_list.map(v=>({id:v.id,status:v.status,index_num:v.index_num,add_time:v.add_time,file_name:v.file_name}))};
});
const fs=await import('node:fs/promises');
await fs.writeFile('D:/WebDesign/CodeWorkspace/dramabridge/tmp/weibo-24812-evidence.json',JSON.stringify(evidence,null,2));
console.log({album:evidence.detail_info.id,episodes:evidence.video_list.length,saved:'tmp/weibo-24812-evidence.json'});
