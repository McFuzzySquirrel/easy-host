import React, { useState } from "react";
import { createRoot } from "react-dom/client";

function App() {
  const [clicks, setClicks] = useState(0);

  return (
    <main>
      <h1>easy-host Vite fixture</h1>
      <p>Static SPA built without a Dockerfile.</p>
      <button type="button" onClick={() => setClicks((count) => count + 1)}>
        clicked {clicks} {clicks === 1 ? "time" : "times"}
      </button>
    </main>
  );
}

const container = document.getElementById("root");

if (container !== null) {
  createRoot(container).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
