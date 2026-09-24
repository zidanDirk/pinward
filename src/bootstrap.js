import("./main.js").catch((error) => {
  console.error("Pinward could not initialize:", error);
  document.getElementById("render-error").hidden = false;
  document.getElementById("start").disabled = true;
});
