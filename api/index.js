// Vercel Serverless Function entry — Express 앱을 그대로 위임
// 로컬에서는 server.js가 직접 listen, Vercel에서는 이 파일이 호출됨
module.exports = require('../server.js');
