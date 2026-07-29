import test from 'node:test';
import assert from 'node:assert/strict';

import {learnProduct} from '../web/js/learn/product.js';

test('each Learn product introduces the stationary origin challenge', () => {
  for (const network of ['bus', 'metro']) {
    const product = learnProduct(network);
    assert.match(product.feedback, /起点站名/);
    assert.match(product.feedback, /保持原位/);
  }
});
