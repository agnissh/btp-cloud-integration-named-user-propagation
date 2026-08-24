sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageBox",
  "sap/m/MessageToast"
], function (Controller, JSONModel, MessageBox, MessageToast) {
  "use strict";

  const API_BASE = "/api/DeployService";

  async function apiFetch(url, opts) {
    const res = await fetch(url, Object.assign({
      headers: { "Accept": "application/json", "Content-Type": "application/json" }
    }, opts));
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = body?.error?.message ?? body?.message ?? res.statusText;
      throw new Error("HTTP " + res.status + ": " + msg);
    }
    return body;
  }

  return Controller.extend("iflowpptest.controller.Main", {

    onInit: function () {
      this.getView().setModel(new JSONModel({
        checked: false,
        summary: "",
        msgType: "Information",
        hasXsuaaToken: "—",
        xsuaaKid: "—",
        xsuaaIssuer: "—",
        xsuaaEmail: "—",
        hasIasToken: "—",
        iasTokenState: "None",
        iasKid: "—",
        iasIssuer: "—",
        iasEmail: "—",
        iasSubject: "—",
        hasRawIasToken: false,
        rawIasToken: ""
      }), "tokenModel");

      this.getView().setModel(new JSONModel({
        destinationName: "target-cpi",
        packagesBusy: false,
        hasPackages: false,
        hasPackagesError: false,
        packagesError: "",
        packages: [],
        selectedPackageId: "",
        selectedPackageName: "",
        showIflows: false,
        iflowsBusy: false,
        hasIflows: false,
        hasIflowsError: false,
        iflowsError: "",
        iflows: [],
        selectedIflowIds: [],
        busy: false,
        hasResult: false,
        resultMessage: "",
        resultType: "Information"
      }), "deployModel");
    },

    // ── TAB 1: Token Check ────────────────────────────────────────────────────
    onCheckToken: function () {
      var tokenModel = this.getView().getModel("tokenModel");
      tokenModel.setProperty("/checked", false);

      apiFetch(API_BASE + "/checkToken()")
        .then(function (data) {
          var r = data.value || data;
          var iasPresent = r.hasIasToken === true;
          tokenModel.setData({
            checked: true,
            summary: iasPresent
              ? "✓ IAS token found in x-identity-token header. Ready for token exchange."
              : "✗ IAS token NOT found. Check AppRouter ENABLE_FORWARD_CORPORATE_IDP_TOKEN setting.",
            msgType: iasPresent ? "Success" : "Error",
            hasXsuaaToken: String(r.hasXsuaaToken),
            xsuaaKid: r.xsuaaKid || "(none)",
            xsuaaIssuer: r.xsuaaIssuer || "(none)",
            xsuaaEmail: r.xsuaaEmail || "(none)",
            hasIasToken: String(r.hasIasToken),
            iasTokenState: iasPresent ? "Success" : "Error",
            iasKid: r.iasKid || "(none)",
            iasIssuer: r.iasIssuer || "(none)",
            iasEmail: r.iasEmail || "(none)",
            iasSubject: r.iasSubject || "(none)",
            hasRawIasToken: !!(r.rawIasToken),
            rawIasToken: r.rawIasToken || ""
          });
        })
        .catch(function (err) {
          tokenModel.setProperty("/checked", true);
          tokenModel.setProperty("/summary", "Error: " + err.message);
          tokenModel.setProperty("/msgType", "Error");
        });
    },

    onCopyIasToken: function () {
      var token = this.getView().getModel("tokenModel").getProperty("/rawIasToken");
      if (navigator.clipboard) {
        navigator.clipboard.writeText(token).then(function () {
          MessageToast.show("IAS token copied to clipboard");
        });
      } else {
        var ta = document.createElement("textarea");
        ta.value = token;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        MessageToast.show("IAS token copied to clipboard");
      }
    },

    // ── TAB 2: Browse & Deploy ────────────────────────────────────────────────
    onRefreshPackages: function () {
      var deployModel = this.getView().getModel("deployModel");
      var destName = deployModel.getProperty("/destinationName") || "target-cpi";

      deployModel.setProperty("/packagesBusy", true);
      deployModel.setProperty("/hasPackages", false);
      deployModel.setProperty("/hasPackagesError", false);
      deployModel.setProperty("/showIflows", false);

      var url = API_BASE + "/getArtifacts(destinationName='" + encodeURIComponent(destName) + "')";

      apiFetch(url)
        .then(function (data) {
          var r = data.value || data;
          deployModel.setProperty("/packagesBusy", false);
          if (r.status === "error") {
            deployModel.setProperty("/hasPackagesError", true);
            deployModel.setProperty("/packagesError", "Error (HTTP " + r.httpStatus + "): " + r.errorMessage);
            return;
          }
          var items = [];
          try { items = JSON.parse(r.artifacts || "[]"); } catch (e) { /* ignore */ }
          deployModel.setProperty("/packages", items);
          deployModel.setProperty("/hasPackages", items.length > 0);
          if (items.length === 0) {
            deployModel.setProperty("/hasPackagesError", true);
            deployModel.setProperty("/packagesError", "No packages found in the target CPI tenant. Check destination configuration and user permissions.");
          }
        })
        .catch(function (err) {
          deployModel.setProperty("/packagesBusy", false);
          deployModel.setProperty("/hasPackagesError", true);
          deployModel.setProperty("/packagesError", "Error: " + err.message);
        });
    },

    onPackageSelect: function (oEvent) {
      var deployModel = this.getView().getModel("deployModel");
      var item = oEvent.getParameter("listItem");
      var ctx = item.getBindingContext("deployModel");
      var packageId = ctx.getProperty("PackageId");
      var packageName = ctx.getProperty("Name");

      deployModel.setProperty("/selectedPackageId", packageId);
      deployModel.setProperty("/selectedPackageName", packageName);
      deployModel.setProperty("/showIflows", true);
      deployModel.setProperty("/iflows", []);
      deployModel.setProperty("/hasIflows", false);
      deployModel.setProperty("/selectedIflowIds", []);

      this._fetchIflowsInPackage(packageId, packageName);
    },

    _fetchIflowsInPackage: function (packageId, packageName) {
      var deployModel = this.getView().getModel("deployModel");
      var destName = deployModel.getProperty("/destinationName") || "target-cpi";

      deployModel.setProperty("/iflowsBusy", true);
      deployModel.setProperty("/hasIflows", false);
      deployModel.setProperty("/hasIflowsError", false);

      var url = API_BASE + "/getIflows(destinationName='" + encodeURIComponent(destName) + "',packageId='" + encodeURIComponent(packageId) + "')";

      apiFetch(url)
        .then(function (data) {
          var r = data.value || data;
          deployModel.setProperty("/iflowsBusy", false);
          if (r.status === "error") {
            deployModel.setProperty("/hasIflowsError", true);
            deployModel.setProperty("/iflowsError", "Error (HTTP " + r.httpStatus + "): " + r.errorMessage);
            return;
          }
          var items = [];
          try { items = JSON.parse(r.artifacts || "[]"); } catch (e) { /* ignore */ }
          items.forEach(function (item) { item.selected = false; });
          deployModel.setProperty("/iflows", items);
          deployModel.setProperty("/hasIflows", items.length > 0);
          if (items.length === 0) {
            deployModel.setProperty("/hasIflowsError", true);
            deployModel.setProperty("/iflowsError", "No iFlows found in package '" + packageName + "'.");
          }
        })
        .catch(function (err) {
          deployModel.setProperty("/iflowsBusy", false);
          deployModel.setProperty("/hasIflowsError", true);
          deployModel.setProperty("/iflowsError", "Error: " + err.message);
        });
    },

    onIflowSelection: function (oEvent) {
      var deployModel = this.getView().getModel("deployModel");
      var oList = oEvent.getSource();
      var selectedItems = oList.getSelectedItems();
      var selectedIds = selectedItems.map(function (item) {
        return item.getBindingContext("deployModel").getProperty("Id");
      });
      deployModel.setProperty("/selectedIflowIds", selectedIds);
    },

    // ── Deploy / Undeploy ─────────────────────────────────────────────────────
    onDeploy: function () { this._triggerCpiAction("deploy"); },
    onUndeploy: function () { this._triggerCpiAction("undeploy"); },

    _triggerCpiAction: function (actionType) {
      var deployModel = this.getView().getModel("deployModel");
      var selectedIds = deployModel.getProperty("/selectedIflowIds");
      var destName = deployModel.getProperty("/destinationName") || "target-cpi";

      if (!selectedIds || selectedIds.length === 0) {
        MessageBox.warning("Please select one or more iFlows to " + actionType + ".");
        return;
      }

      deployModel.setProperty("/busy", true);
      deployModel.setProperty("/hasResult", false);

      var endpoint = actionType === "deploy"
        ? API_BASE + "/deployArtifact"
        : API_BASE + "/undeployArtifact";

      apiFetch(endpoint, {
        method: "POST",
        body: JSON.stringify({
          artifactIds: selectedIds,
          destinationName: destName
        })
      })
        .then(function (data) {
          var r = data.value || data;
          deployModel.setProperty("/busy", false);
          deployModel.setProperty("/hasResult", true);

          var successCount = (r.results || []).filter(function (res) { return res.status === "success"; }).length;
          var action = actionType === "deploy" ? "Deployed" : "Undeployed";
          var summary = action + " " + successCount + " of " + selectedIds.length + " iFlow(s). Check the CPI Audit Log to verify named user attribution.";

          deployModel.setProperty("/resultMessage", summary);
          deployModel.setProperty("/resultType", successCount > 0 ? "Success" : "Error");
        })
        .catch(function (err) {
          deployModel.setProperty("/busy", false);
          deployModel.setProperty("/hasResult", true);
          deployModel.setProperty("/resultMessage", "Error: " + err.message);
          deployModel.setProperty("/resultType", "Error");
        });
    }

  });
});
