const fetch = require('node-fetch');
async function test() {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models`);
  const text = await res.text();
  console.log("Status:", res.status);
}
test();
