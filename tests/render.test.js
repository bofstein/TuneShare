import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout } from '../src/layout.js';
import { renderSystems } from '../src/render.js';
import * as M from '../src/model.js';
import { parse, tune } from './helpers.js';

const draw = t => renderSystems(layout(t, { width: 900, perSys: 4, sp: 10 }));
const bar = 'C4:q D4:q E4:q F4:q ';
const eight = (over = {}) => tune(bar.repeat(8), { measures: 8, ...over });
const count = (s, re) => (s.match(re) || []).length;

test('one group per system', () => {
  assert.equal(draw(eight()).systems.length, 2);
  assert.equal(draw(tune('C4:q', { measures: M.MAX_MEASURES })).systems.length, M.MAX_MEASURES / 4);
});

test('systems hold every drawn element exactly once', () => {
  const t = { ...eight(), staff2: { clef: 'bass', events: parse('C3:w C3:w C3:w C3:w D3:w D3:w D3:w D3:w') } };
  const lay = layout(t, { width: 900, perSys: 4, sp: 10 });
  const { systems } = renderSystems(lay);
  const items = lay.staff.length + lay.implicit.length + lay.beams.length + lay.events.reduce((a, m) => a + [...m.values()].reduce((b, v) => b + v.length, 0), 0);
  assert.equal(count(systems.join(''), /<(text|line|rect|polygon|path)\b/g), items);
  for (const [s, evs] of lay.events.entries()) for (const i of evs.keys()) {
    assert.ok(systems.some(g => g.includes(`data-s="${s}" data-i="${i}"`)), `event ${s}:${i} is drawn`);
  }
});

test('an edit in one system leaves the other systems\' markup identical', () => {
  const a = draw(eight()), b = draw(M.replace(eight(), 1, parse('G4:q')[0]).tune);
  assert.equal(a.open, b.open);
  assert.notEqual(a.systems[0], b.systems[0]);
  assert.equal(a.systems[1], b.systems[1]);
});

test('an edit in the last system leaves the first one identical', () => {
  const a = draw(eight()), b = draw(M.replace(eight(), 30, parse('G4:q')[0]).tune);
  assert.equal(a.systems[0], b.systems[0]);
  assert.notEqual(a.systems[1], b.systems[1]);
});

test('a tie across the line break is drawn in both systems', () => {
  const t = tune(bar.repeat(3) + 'C4:q C4:q C4:q D4:h ' + bar.repeat(3), { measures: 8 });
  const { systems } = draw(t);
  const group = `data-s="0" data-i="15"`;
  assert.ok(systems[0].includes(group) && systems[1].includes(group));
});

test('events and staves stay in order inside a system', () => {
  const t = { ...eight(), staff2: { clef: 'bass', events: parse('C3:w C3:w') } };
  const [first] = draw(t).systems;
  const order = [...first.matchAll(/data-s="(\d)" data-i="(\d+)"/g)].map(m => [+m[1], +m[2]]);
  assert.deepEqual(order, [...order].sort((x, y) => x[0] - y[0] || x[1] - y[1]));
});
