const task=await taskSpace(15);const page=task.page("p1");
await page.click('text="下一步：查看视频"');
await page.waitForSelector('.video-card',{timeout:15000});
console.log({url:await page.url(),dom:await page.evaluate(()=>({cards:document.querySelectorAll('.video-card').length,body:document.body.innerText.slice(0,1800)}))});
console.log(await page.evaluate(async()=>{const r=await fetch('https://api-duanju.weibo.com/creator/album/info?id=24812',{headers:{Authorization:`Bearer ${localStorage.getItem('token')}`},credentials:'include',signal:AbortSignal.timeout(10000)});const j=await r.json();const v=j.data?.video_list??[];return {status:j.status,detail:j.data?.detail_info,videos:v.length,keys:Object.keys(v[0]??{}),sample:v.slice(0,2),indexes:v.map(x=>x.index_num)};}));
