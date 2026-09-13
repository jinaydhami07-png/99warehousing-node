/**
 * Favourite routes — mounted at /api/v1/favorites.
 *
 * Every route is per-account, so the whole router sits behind authenticate.
 * Signed-out visitors keep their favourites in localStorage (see
 * public/assets/bpsf-store.js), which are pushed up on sign-in.
 */
'use strict';

const express = require('express');
const controller = require('../controllers/favorite.controller');
const validate = require('../middleware/validate.middleware');
const { authenticate } = require('../middleware/auth.middleware');
const { byId } = require('../validators/property.validator');

const router = express.Router();

router.use(authenticate);

router.get('/', controller.list);
router.post('/:id', validate(byId), controller.add);
router.delete('/:id', validate(byId), controller.remove);

module.exports = router;
