const task=await taskSpace(15);const page=task.page("p1");
console.log({url:await page.url()});console.log(await page.snapshot());
