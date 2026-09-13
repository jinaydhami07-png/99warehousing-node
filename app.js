/**
 * Startup file for cPanel's "Setup Node.js App" (Phusion Passenger).
 *
 * cPanel asks for an "Application startup file" at the application root, and
 * runs whatever it finds there. The real entry point lives in
 * server/src/server.js — this hands straight over to it, so there is only one
 * copy of the boot sequence (database connection, graceful shutdown, error
 * handlers) rather than a second one that could drift.
 *
 * Nothing else belongs in here. If the app needs different behaviour under
 * Passenger, that belongs in server/src/server.js behind a check, not in a
 * parallel entry point.
 */
'use strict';

require('./server/src/server.js');
