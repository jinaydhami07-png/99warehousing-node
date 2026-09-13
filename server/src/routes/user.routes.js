'use strict';

const express = require('express');
const userController = require('../controllers/user.controller');
const validate = require('../middleware/validate.middleware');
const { authenticate, authorize } = require('../middleware/auth.middleware');
const schemas = require('../validators/user.validator');

const router = express.Router();

/* Everything below requires a session. Applied once at the top rather than
   repeated per route, so a newly added route cannot ship unprotected by
   accident. */
router.use(authenticate);

router.get('/me', userController.getMe);
router.patch('/me', validate(schemas.updateMe), userController.updateMe);

/* Admin-only from here down. */
router.use(authorize('admin'));

router.get('/', validate(schemas.listQuery), userController.listUsers);
router.post('/', validate(schemas.register), userController.createUser);
router.get('/:id', validate(schemas.byId), userController.getUser);
router.patch('/:id', validate(schemas.adminUpdateUser), userController.updateUser);

module.exports = router;
