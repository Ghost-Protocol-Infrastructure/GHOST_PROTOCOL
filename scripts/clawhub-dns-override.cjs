const dns = require("node:dns");

const TARGET_HOST = "clawhub.ai";
const OVERRIDE_ADDRESS = "216.150.16.1";
const OVERRIDE_FAMILY = 4;

function isTargetHost(hostname) {
  return typeof hostname === "string" && hostname.toLowerCase() === TARGET_HOST;
}

const originalLookup = dns.lookup.bind(dns);
dns.lookup = function lookup(hostname, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }

  if (isTargetHost(hostname)) {
    if (options && typeof options === "object" && options.all) {
      process.nextTick(() => callback(null, [{ address: OVERRIDE_ADDRESS, family: OVERRIDE_FAMILY }]));
      return;
    }
    process.nextTick(() => callback(null, OVERRIDE_ADDRESS, OVERRIDE_FAMILY));
    return;
  }

  return originalLookup(hostname, options, callback);
};

if (dns.promises && typeof dns.promises.lookup === "function") {
  const originalPromiseLookup = dns.promises.lookup.bind(dns.promises);
  dns.promises.lookup = async function lookup(hostname, options) {
    if (isTargetHost(hostname)) {
      if (options && typeof options === "object" && options.all) {
        return [{ address: OVERRIDE_ADDRESS, family: OVERRIDE_FAMILY }];
      }
      return { address: OVERRIDE_ADDRESS, family: OVERRIDE_FAMILY };
    }
    return originalPromiseLookup(hostname, options);
  };
}
