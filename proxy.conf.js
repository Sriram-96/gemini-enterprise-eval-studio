const BACKEND_PORT = process.env.PORT || 3000;

const PROXY_CONFIG = {
  "/api": {
    "target": `http://localhost:${BACKEND_PORT}`,
    "secure": false
  },
  "/auth": {
    "target": `http://localhost:${BACKEND_PORT}`,
    "secure": false
  }
};

module.exports = PROXY_CONFIG;
