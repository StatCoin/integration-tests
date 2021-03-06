var querystring = require('querystring');
var express = require('express');
var proxy = require('express-http-proxy');
var app = express();
var bodyParser = require('body-parser');
var morgan = require('morgan');
var axios = require('axios');

var tests = {
  send: {status: "pending"},
  receive: {status: "pending"}
};

app.use(morgan('dev'));

// We forward auth requests to bridge server instead of creating another
// ngrok tunnel to bridge server port.
app.use('/auth', proxy('http://localhost:'+process.env.COMPLIANCE_EXTERNAL_PORT));

app.use(bodyParser.urlencoded({extended: false}));

const stellarToml = '# Stellar.toml\n'+
  'FEDERATION_SERVER="https://'+process.env.FI_DOMAIN+'/federation"\n'+
  'AUTH_SERVER="https://'+process.env.FI_DOMAIN+'/auth"\n'+
  'SIGNING_KEY="'+process.env.SIGNING_ACCOUNT+'"\n';

// stellar.toml
app.get('/.well-known/stellar.toml', function (req, res) {
  res.set('Content-Type', 'text/x-toml');
  res.set('Access-Control-Allow-Origin', '*');
  res.send(stellarToml);
})

// federation
app.get('/federation', function (req, res) {
  if (req.query.type != "name") {
    res.status(400).send('Invalid type');
    return
  }

  if (!req.query.q) {
    res.status(400).send('Invalid q');
    return
  }

  res.set('Content-Type', 'application/json');
  res.set('Access-Control-Allow-Origin', '*');

  // TODO more tests
  res.send({
    account_id: process.env.RECEIVING_ACCOUNT,
    memo_type: "id",
    memo: "1"
  });
});

// receive callback
app.post('/receive', function (req, res) {
  console.log("/receive callback: "+JSON.stringify(req.body));
  res.send("OK");
  assertReceiveTest(req.body);
});

// sanctions callback
app.post('/sanctions', function (req, res) {
  console.log("/sanctions callback: "+JSON.stringify(req.body));
  res.send("OK");
});

// ask_user callback
app.post('/ask_user', function (req, res) {
  console.log("/ask_user callback: "+JSON.stringify(req.body));
  res.send("OK");
});

// fetch_info callback
app.post('/fetch_info', function (req, res) {
  console.log("/fetch_info callback: "+JSON.stringify(req.body));
  res.send({
    first_name: "John",
    middle_name: process.env.FI_DOMAIN,
    last_name: "Doe",
    address: "User physical address",
    date_of_birth: "1980-01-01"
  });
});

// Endpoint for monitoring app. Simply returns tests status.
app.get('/tests', function (req, res) {
  res.send(tests);
});

// Endpoint to trigger tests called by monitoring app when
// both FIs are online.
app.post('/tests', function (req, res) {
  sendPayment();
  res.send("OK");
});

app.listen(process.env.FI_PORT, function () {
  console.log('Server listening!')
});

function sendPayment() {
  // Check if the other FI is online already. If not repeat after 5 seconds.
  console.log("Sending payment to "+process.env.OTHER_FI_DOMAIN+"...")
  var query = querystring.stringify({
    // Use compliance protocol
    use_compliance: true,
    sender: "sender*"+process.env.FI_DOMAIN,
    destination: "user1*"+process.env.OTHER_FI_DOMAIN,
    amount: 1,
    asset_code: "TEST",
    asset_issuer: process.env.ISSUING_ACCOUNT
  });
  axios.post("http://localhost:"+process.env.BRIDGE_PORT+"/payment", query)
    .then(function(response) {
      console.log(response.data);
      tests.send.status = "success";
    })
    .catch(function (response) {
      console.error("Error: "+response.headers.status);
      console.error(response.data);
      tests.send.status = "fail";
    });
}

function assertReceiveTest(body) {
  if (body.from == process.env.RECEIVING_ACCOUNT) {
    return failTest("receive", "Received from itself!");
  }

  if (body.route != 1) {
    return failTest("receive", "Invalid route: "+body.route);
  }

  if (body.amount !== "1.0000000") {
    return failTest("receive", "Invalid amount: "+body.amount);
  }

  if (body.asset_code !== "TEST") {
    return failTest("receive", "Invalid asset_code: "+body.asset_code);
  }

  let data = JSON.parse(body.data);

  if (data.sender !== "sender*"+process.env.OTHER_FI_DOMAIN) {
    return failTest("receive", "Invalid data.sender: "+data.sender);
  }

  let attachment = JSON.parse(data.attachment);
  let expectedAttachmentTransaction = {
    // sender_info keys will be sorted alphabetically (Go map)
    sender_info: {
      address: "User physical address",
      date_of_birth: "1980-01-01",
      first_name: "John",
      last_name: "Doe",
      middle_name: process.env.OTHER_FI_DOMAIN
    },
    route: "1",
    note: "",
    extra: ""
  };

  if (JSON.stringify(attachment.transaction) != JSON.stringify(expectedAttachmentTransaction)) {
    return failTest("receive", "Invalid attachment.transaction: "+JSON.stringify(attachment.transaction)+" expected: "+JSON.stringify(expectedAttachmentTransaction));
  }

  tests.receive.status = "success";
}

function failTest(testName, error) {
  tests[testName].status = "fail";
  tests[testName].error = error;
}
