// Requires the isolated grid fixture; never point this script at a business application.
const {chromium}=await import(process.env.DBTERM_PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:process.env.DBTERM_TEST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 const page=await browser.newPage();
 await page.goto(process.env.DBTERM_GRID_FIXTURE_URL || 'http://127.0.0.1:1437/__grid');
 const cell=page.locator('.tb-table tbody tr').first().locator('td').nth(2);await cell.waitFor();
 await page.evaluate(()=>{const original=window.__TAURI_INTERNALS__.invoke;window.__TAURI_INTERNALS__.invoke=async(cmd,args)=>{if(cmd==='db_delete_rows'){window.calls.push({cmd,args});throw new Error('删除提交未获确认，结果未知，请核对目标，禁止自动重试')}return original(cmd,args)}});
 await cell.click({button:'right'});
 await page.getByText('删除行',{exact:true}).click();
 const before=await page.evaluate(()=>window.calls.filter(c=>c.cmd==='execute_query'&&c.args.sql.startsWith('SELECT *')).length);
 await page.getByRole('button',{name:'确认删除',exact:true}).evaluate(button=>{button.click();button.click()});
 await page.waitForFunction(()=>window.calls.some(c=>c.cmd==='db_delete_rows'));
 await page.waitForTimeout(100);
 const retry=page.getByRole('button',{name:'确认删除',exact:true});
 assert.ok(await retry.count()===0||await retry.isDisabled(),'unconfirmed DELETE must not leave an enabled retry button with stale baseline');
 assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.cmd==='db_delete_rows').length),1);
 await page.waitForFunction(before=>window.calls.filter(c=>c.cmd==='execute_query'&&c.args.sql.startsWith('SELECT *')).length>before,before);
 console.log('PASS unconfirmed delete blocks repeat submission until confirmation is dismissed and data refreshed');
} finally {await browser.close()}
