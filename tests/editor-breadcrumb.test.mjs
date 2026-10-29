import test from 'node:test';import assert from 'node:assert/strict';
import {breadcrumbParts} from '../.test-build/editor-breadcrumb.js';
test('breadcrumbs preserve Windows drive, UNC and POSIX identity without changing source paths',()=>{
  for(const [input,side,folders,filename] of [
    ['C:\\work\\日本語\\note.txt','local',['C:\\','work','日本語'],'note.txt'],
    ['D:/work//notes.txt','local',['D:\\','work'],'notes.txt'],
    ['\\\\server\\share\\folder\\note.txt','local',['\\\\server\\share','folder'],'note.txt'],
    ['//server/share/note.txt','local',['\\\\server\\share'],'note.txt'],
    ['/data/main/function/time_leap/2.reset_gimmicks.mcfunction','remote',['/','data','main','function','time_leap'],'2.reset_gimmicks.mcfunction'],
    ['//a///日本語/😀.txt','remote',['/','a','日本語'],'😀.txt'],
    ['/folder/literal\\name.txt','remote',['/','folder'],'literal\\name.txt'],
    ['notes.txt','local',[],'notes.txt'],['/','remote',['/'],''],['C:\\','local',['C:\\'],''],
    ['\\\\server\\share','local',['\\\\server\\share'],''],['','remote',[],''],
    ['./a/../b.txt','remote',['.','a','..'],'b.txt'],
  ])assert.deepEqual(breadcrumbParts(input,side),{folders,filename},input);
});
