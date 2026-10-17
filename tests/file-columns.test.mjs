import test from 'node:test';
import assert from 'node:assert/strict';
import { fileType, modifiedText, visibleColumns, columnsWidth } from '../.test-build/file-columns.js';
import {defaultPaneColumns} from '../.test-build/explorer-preferences.js';
test('file types are deterministic across case, extensions and folders',()=>{
 for(const name of ['photo.jpg','PHOTO.JPG','photo.jpeg'])assert.equal(fileType({name,dir:false}),'JPEG 画像');
 assert.equal(fileType({name:'notes.TXT',dir:false}),'テキスト ドキュメント');
 assert.equal(fileType({name:'archive.custom',dir:false}),'CUSTOM ファイル');
 assert.equal(fileType({name:'.gitignore',dir:false}),'ファイル');
 assert.equal(fileType({name:'.GITIGNORE',dir:false}),'ファイル');
 assert.equal(fileType({name:'README',dir:false}),'ファイル');
 assert.equal(fileType({name:'image.jpg',dir:true}),'フォルダー');
 assert.equal(modifiedText({name:'a',dir:false,size:0}), '');
 assert.equal(modifiedText({name:'a',dir:false,size:0,modifiedAt:NaN}), '');
 assert.match(modifiedText({name:'a',dir:false,size:0,modifiedAt:1700000000}),/2023/);
});
test('fixed pixel columns keep mandatory name visible and derive width only from visible columns',()=>{
 const c=defaultPaneColumns().local;c.order=['modified','name','type','size'];c.hidden=['size'];c.widths.name=320;
 assert.deepEqual(visibleColumns(c),['modified','name','type']);assert.equal(columnsWidth(c),590);
 c.hidden.push('name');assert.ok(visibleColumns(c).includes('name'));
});
