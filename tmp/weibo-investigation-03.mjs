const task = await taskSpace(15);
const page = task.page("p1");
await page.waitForSelector('input[placeholder="搜索合集名称"]',{timeout:15000});
await page.fill('input[placeholder="搜索合集名称"]',"第19个电话");
await page.press('input[placeholder="搜索合集名称"]',"Tab");
console.log(await page.snapshot());
