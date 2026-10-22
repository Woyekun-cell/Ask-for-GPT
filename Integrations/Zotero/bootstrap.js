/* Reader adapter verified against Zotero 9.0.6 and reader 9643fac7a4e86c8d7ff9548af0191e9df63aa998.
 * https://www.zotero.org/support/dev/zotero_7_for_developers#custom_reader_event_handlers
 * https://github.com/zotero/reader/blob/9643fac7a4e86c8d7ff9548af0191e9df63aa998/src/pdf/pdf-view.js
 */
var askGPTInlineScope = null;
var askGPTInlineGeneration = 0;

async function startup(data, reason) {
  const generation = ++askGPTInlineGeneration;
  await Zotero.initializationPromise;
  await Zotero.uiReadyPromise;
  if (generation !== askGPTInlineGeneration || !/^9\./.test(Zotero.version)) return;
  const scope = { Zotero, Services, Components, ChromeUtils };
  Services.scriptloader.loadSubScript(data.rootURI + 'content/inline-core.js', scope);
  Services.scriptloader.loadSubScript(data.rootURI + 'content/pdf-layout.js', scope);
  Services.scriptloader.loadSubScript(data.rootURI + 'content/pdf-pane-gestures.js', scope);
  Services.scriptloader.loadSubScript(data.rootURI + 'content/pdf-reading-tools.js', scope);
  Services.scriptloader.loadSubScript(data.rootURI + 'content/pdf-selection-link.js', scope);
  Services.scriptloader.loadSubScript(data.rootURI + 'content/pdf-figure-navigation.js', scope);
  Services.scriptloader.loadSubScript(data.rootURI + 'content/pdf-figure-panel.js', scope);
  Services.scriptloader.loadSubScript(data.rootURI + 'content/pdf-scroll-sync.js', scope);
  Services.scriptloader.loadSubScript(data.rootURI + 'content/pdf-native-view.js', scope);
  Services.scriptloader.loadSubScript(data.rootURI + 'content/sidebar.js', scope);
  Services.scriptloader.loadSubScript(data.rootURI + 'content/connection-security.js', scope);
  Services.scriptloader.loadSubScript(data.rootURI + 'content/inline.js', scope);
  const css = await Zotero.File.getContentsFromURLAsync(data.rootURI + 'content/inline.css');
  if (generation !== askGPTInlineGeneration) return;
  let diagnosticWrite = Promise.resolve();
  const reportDiagnostic = (stage, error) => {
    const record = scope.AskGPTPDFLayout.diagnostic(stage, error);
    diagnosticWrite = diagnosticWrite.then(async () => {
      await scope.AskGPTConnectionSecurity.writeDiagnostic({ Zotero, Services, Components, ChromeUtils }, record);
    }).catch(() => {});
    return diagnosticWrite;
  };
  scope.instance = scope.AskGPTInline.create({ Zotero, Services, Components, ChromeUtils, css, reportDiagnostic,
    pluginID: data.id, rootURI: data.rootURI, readText: path => Zotero.File.getContentsAsync(path, 'UTF-8', 4096),
    setTimer: setTimeout, clearTimer: clearTimeout });
  askGPTInlineScope = scope;
  scope.instance.start();
}

function onMainWindowLoad({ window }) { askGPTInlineScope?.instance?.attachMainWindow(window); }
function onMainWindowUnload({ window }) { askGPTInlineScope?.instance?.detachMainWindow(window); }
function shutdown(data, reason) {
  askGPTInlineGeneration++;
  askGPTInlineScope?.instance?.shutdown();
  askGPTInlineScope = null;
}
function install() {}
function uninstall() {}
