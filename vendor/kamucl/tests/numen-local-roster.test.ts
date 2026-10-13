import test from 'node:test'
import assert from 'node:assert/strict'
import { activeLocalCompanions } from '../src/main/core/numen/companionRoster'
test('dormant UUID is not offered as an active body, while another same-name companion is preserved', () => {
 const sleeping={id:'sleeping-uuid',name:'Bot'},other={id:'live-uuid',name:'Bot'},roster=[sleeping,other]
 assert.deepEqual(activeLocalCompanions(roster,[{id:sleeping.id}]),[other])
 assert.deepEqual(activeLocalCompanions(roster,[]),roster)
 assert.deepEqual(roster,[sleeping,other])
})
