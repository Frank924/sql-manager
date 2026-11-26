import test from 'node:test';
import assert from 'node:assert/strict';
import {requiredScriptIds, pendingScriptIds, confirmedVersion, environmentState, planBlocker, reconcileExecution, formatDateTime} from '../src/model.js';

const releases = [
  {id:'v2.0.0',previous:null,baseline:'B001',scriptIds:['B001'],status:'published'},
  {id:'v2.1.0',previous:'v2.0.0',baseline:'B001',scriptIds:['S001','S002'],status:'published'},
  {id:'v2.2.0',previous:'v2.1.0',baseline:'B001',scriptIds:[],status:'published'},
  {id:'v2.3.0',previous:'v2.2.0',baseline:'B001',scriptIds:['S003'],status:'draft'},
];
const empty = {id:'test',baseline:null,baseBaseline:null,baseApplied:[],applied:[],issues:[],codeVersion:'v2.0.0'};
const existing = {...empty,baseline:'B001',baseBaseline:'B001',baseApplied:['B001'],applied:['B001']};
const scripts = [{id:'B001',type:'baseline'},{id:'S001',type:'increment'},{id:'S002',type:'increment'}];

test('空工作区所有计算均可安全显示',()=>{
  assert.deepEqual(requiredScriptIds([],null),[]);
  assert.deepEqual(pendingScriptIds(undefined,[],null),[]);
  assert.equal(confirmedVersion(undefined,[]),'—');
  assert.match(planBlocker(undefined,[],null),/环境/);
});
test('跨版本差集保留发布顺序且不修改数据',()=>{
  const before=structuredClone({existing,releases});
  assert.deepEqual(requiredScriptIds(releases,'v2.2.0'),['B001','S001','S002']);
  assert.deepEqual(pendingScriptIds(existing,releases,'v2.2.0'),['S001','S002']);
  assert.deepEqual({existing,releases},before);
});
test('仅代码更新的发布不会要求重复SQL或改变已登记代码版本',()=>{
  const env={...existing,applied:['B001','S001','S002']};
  assert.equal(confirmedVersion(env,releases),'v2.2.0');
  assert.equal(environmentState(env,releases),'已确认');
  assert.equal(env.codeVersion,'v2.0.0');
});
test('首次安装需要未接管环境，升级需要基线，草稿不可交付',()=>{
  assert.equal(planBlocker(empty,releases,'v2.1.0','install'),null);
  assert.match(planBlocker(empty,releases,'v2.1.0'),/登记现有基线/);
  assert.match(planBlocker(existing,releases,'v2.1.0','install'),/不能按空库/);
  assert.match(planBlocker(existing,releases,'v2.3.0'),/已发布/);
});
test('部分失败优先于缺少基线，并阻止继续导出',()=>{
  const env={...empty,issues:['B001']};
  assert.equal(environmentState(env,releases),'待核实');
  assert.match(planBlocker(env,releases,'v2.1.0','install'),/未核实/);
});
test('目标清单不包含已执行变更时不允许降级',()=>{
  assert.match(planBlocker({...existing,applied:['B001','S001']},releases,'v2.0.0'),/降级/);
});
test('未执行记录不能撤销另一交付包成功，失败也不能被其他包掩盖',()=>{
  const packages=[
    {envId:'test',scriptIds:['S001','S002'],results:{S001:'success',S002:'partial'}},
    {envId:'test',scriptIds:['S001','S002'],results:{S001:'notExecuted',S002:'success'}},
  ];
  const env=reconcileExecution(existing,packages,scripts);
  assert.deepEqual(env.applied,['B001','S001','S002']);
  assert.deepEqual(env.issues,['S002']);
  assert.equal(env.codeVersion,existing.codeVersion);
  assert.equal(confirmedVersion(env,releases),'v2.0.0');
});
test('撤回安装基线成功后重新派生环境状态',()=>{
  const pkg={envId:'test',scriptIds:['B001'],results:{B001:'success'}};
  const installed=reconcileExecution(empty,[pkg],scripts);
  assert.equal(installed.baseline,'B001');
  const corrected=reconcileExecution(installed,[{...pkg,results:{B001:'notExecuted'}}],scripts);
  assert.equal(corrected.baseline,null);
  assert.deepEqual(corrected.applied,[]);
});
test('未知版本与循环链明确报错，不返回误导清单',()=>{
  assert.throws(()=>requiredScriptIds(releases,'missing'),/找不到/);
  assert.throws(()=>requiredScriptIds([{id:'a',previous:'b'},{id:'b',previous:'a'}],'a'),/循环/);
});
test('时间字段为空时不显示Invalid Date',()=>{
  assert.equal(formatDateTime(null),'—');
  assert.equal(formatDateTime('—'),'—');
});
