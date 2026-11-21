const task = await taskSpace(15);
const page = task.page("p1");
await page.click('text="合集管理"');
console.log(await page.snapshot());
