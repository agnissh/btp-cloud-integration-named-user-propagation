sap.ui.define(["sap/ui/core/ComponentContainer"], function (ComponentContainer) {
  "use strict";
  new ComponentContainer({
    name: "iflowpptest",
    settings: { id: "app" },
    async: true
  }).placeAt("content");
});
