const express = require("express");

const port = Number.parseInt(process.env.PORT ?? "", 10);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("PORT must be set to a valid TCP port");
  process.exit(1);
}

const app = express();

app.get("/", (_request, response) => {
  response.json({ status: "ok", service: "express-api" });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`express-api listening on port ${port}`);
});
