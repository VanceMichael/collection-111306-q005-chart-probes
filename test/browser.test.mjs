import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {startSource} from '../src/source.mjs';
test('真实浏览器呈现及操作保留源端特殊情形',{timeout:20000},async()=>{
 const source=await startSource();const browser=await chromium.launch({headless:true});
 const context=await browser.newContext({acceptDownloads:true});const page=await context.newPage();
 const action=async action=>{const response=await fetch(source.url+'/api/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action})});assert.equal(response.status,200);return response.json();};
 try{await page.goto(source.url);await page.waitForFunction(()=>window.portalReady);await page.locator('#plot').hover({position:{x:200,y:140}});
await page.waitForFunction(()=>document.querySelector('#tip').textContent.includes('s1'));
assert.equal(JSON.parse(await page.locator('#tip').textContent()).series,'s1');
await page.locator('button[data-series=s2]').click();
await page.locator('#plot').hover({position:{x:400,y:100}});
await page.waitForFunction(()=>document.querySelector('#tip').textContent.includes('s2'));
assert.equal(JSON.parse(await page.locator('#tip').textContent()).value,27);}
 finally{await browser.close();await source.close();}
});
