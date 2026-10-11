import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertCloudModPermission } from '../src/main/core/cloudResourcePolicy'

test('local instances do not need cloud authorization', () => assert.doesNotThrow(() => assertCloudModPermission([], [])))
test('instance MOD manager may modify bound copies', () => assert.doesNotThrow(() => assertCloudModPermission([{id:'one',name:'One',permissions:['mods.manage']}], ['one','one'])))
test('read-only members cannot modify MODs', () => assert.throws(() => assertCloudModPermission([{id:'one',name:'One',permissions:['instance.read']}], ['one']), /MOD 管理权限/))
test('save permissions never confer instance MOD rights', () => assert.throws(() => assertCloudModPermission([{id:'one',name:'One',permissions:[],savePermissions:{save:['mods.manage']}}], ['one']), /MOD 管理权限/))
test('revoked or removed instances fail closed', () => assert.throws(() => assertCloudModPermission([], ['one']), /MOD 管理权限/))
test('all instances sharing a directory must authorize a change', () => assert.throws(() => assertCloudModPermission([{id:'one',name:'One',permissions:['mods.manage']},{id:'two',name:'Two',permissions:[]}], ['one','two']), /MOD 管理权限/))
