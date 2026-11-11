'use strict';
// Ordered list of schema migrations. To change the schema, add a new numbered file and list it
// here; never edit a migration that has already shipped.
module.exports = [
  require('./001-baseline'),
  require('./002-user-email'),
  require('./003-session-activity'),
  require('./004-device-tokens'),
];
