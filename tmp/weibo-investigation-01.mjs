const task = await taskSpace("排查微博61集重复上传");
const page = task.page("p1");
await page.goto("https://duanju.mcn.weibo.com");
console.log({spaceId:task.spaceId});
console.log(await page.snapshot());
