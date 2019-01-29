let debug_module : Function;

try {
  debug_module = require('debug');
} catch (error) {
  debug_module = function () {
    return console.log;/* function() {} */
  };
}

export function create_debug(namespace : string) {
  return debug_module(namespace);
}
