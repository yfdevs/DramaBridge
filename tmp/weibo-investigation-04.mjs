const task = await taskSpace(15);
const page = task.page("p1");
await page.waitForFunction(()=>document.querySelectorAll('.el-table__body .el-table__row').length===1,undefined,{timeout:10000});
await page.click('text="查看"');
await page.waitForSelector('.video-card',{timeout:15000});
console.log({url:await page.url(),counts:await page.evaluate(()=>({cards:document.querySelectorAll('.video-card').length,text:document.body.innerText.slice(-2500)}))});
console.log(await page.snapshot());
