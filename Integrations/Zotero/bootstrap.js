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
  if (generation !== askGPTInlineGeneration || !/^(?:9\.|10\.0\.)/.test(Zotero.version)) return;
  const scope = { Zotero, Services, Components, ChromeUtils, IOUtils };
  // Match Zotero's plugin bootstrap loader: a replaced XPI keeps the same URI,
  // so its owned modules must not reuse bytecode from an older plugin build.
  const loadScript=path=>Services.scriptloader.loadSubScriptWithOptions(data.rootURI+path,{target:scope,ignoreCache:true});
  loadScript('content/inline-core.js');
  loadScript('content/pdf-layout.js');
  loadScript('content/pdf-connection.js');
  loadScript('content/pdf-local-version.js');
  loadScript('content/pdf-translated-annotations.js');
  loadScript('content/pdf-pane-gestures.js');
  loadScript('content/pdf-reading-tools.js');
  loadScript('content/pdf-hover-gloss.js');
  loadScript('content/pdf-reading-resume.js');
  loadScript('content/pdf-reading-resume-store.js');
  loadScript('content/pdf-selection-link.js');
  loadScript('content/pdf-figure-navigation.js');
  loadScript('content/pdf-figure-panel.js');
  loadScript('content/pdf-figure-markup.js');
  loadScript('content/pdf-figure-markup-store.js');
  loadScript('content/pdf-figure-region.js');
  loadScript('content/pdf-figure-bridge.js');
  loadScript('content/pdf-figure-reader.js');
  loadScript('content/pdf-figure-window.js');
  loadScript('content/pdf-figure-preview.js');
  loadScript('content/pdf-scroll-sync.js');
  loadScript('content/pdf-native-view.js');
  loadScript('content/sidebar.js');
  loadScript('content/connection-security.js');
  loadScript('content/ask-paper.js');
  loadScript('content/ask-paper-shortcut.js');
  loadScript('content/paper-reading-actions.js');
  loadScript('content/paper-command-parser.js');
  loadScript('content/paper-topic.js');
  loadScript('content/paper-commands.js');
  loadScript('content/paper-chat-panel.js');
  loadScript('content/paper-supplements.js');
  loadScript('content/paper-html-version.js');
  loadScript('content/paper-html-appearance.js');
  loadScript('content/paper-native-menu.js');
  loadScript('content/paper-supplement-panel.js');
  loadScript('content/inline.js');
  const css = await Zotero.File.getResourceAsync(data.rootURI + 'content/inline.css');
  if (generation !== askGPTInlineGeneration) return;
  let diagnosticWrite = Promise.resolve();
  const diagnosticStarted=Date.now();
  const figureRecords=[],pdfRecords=[];
  const reportDiagnostic = (stage, error) => {
    const record = scope.AskGPTPDFLayout.diagnostic(stage, error);
    record.elapsedMilliseconds=Math.max(0,Date.now()-diagnosticStarted);
    const records=stage.startsWith('figure')?figureRecords:pdfRecords;records.push({...record});if(records.length>12)records.shift();record.recentRecords=records.slice();
    diagnosticWrite = diagnosticWrite.then(async () => {
      await scope.AskGPTConnectionSecurity.writeDiagnostic({ Zotero, Services, Components, ChromeUtils }, record);
    }).catch(() => {});
    return diagnosticWrite;
  };
  const dependencies = { Zotero, Services, Components, ChromeUtils, IOUtils, css, reportDiagnostic,
    pluginID: data.id, rootURI: data.rootURI, readText: path => Zotero.File.getContentsAsync(path, 'UTF-8', 4096),
    setTimer: setTimeout, clearTimer: clearTimeout };
  scope.pdfConnection = scope.AskGPTPDFConnection.create(dependencies);
  dependencies.ensurePDFReady = scope.pdfConnection.ensure;
  scope.askConnection = scope.AskGPTPDFConnection.create(dependencies, {inline: true});
  dependencies.ensureAskReady = scope.askConnection.ensure;
  scope.instance = scope.AskGPTInline.create(dependencies);
  askGPTInlineScope = scope;
  scope.instance.start();
  scope.paperHTMLAppearance = scope.AskGPTPaperHTMLAppearance.create(dependencies);
  scope.paperHTMLAppearance?.start();
}

function onMainWindowLoad({ window }) {
  askGPTInlineScope?.instance?.attachMainWindow(window);
  askGPTInlineScope?.paperHTMLAppearance?.attachMainWindow(window);
}
function onMainWindowUnload({ window }) {
  askGPTInlineScope?.paperHTMLAppearance?.detachMainWindow(window);
  askGPTInlineScope?.instance?.detachMainWindow(window);
}
function shutdown(data, reason) {
  askGPTInlineGeneration++;
  askGPTInlineScope?.pdfConnection?.dispose();
  askGPTInlineScope?.askConnection?.dispose();
  askGPTInlineScope?.paperHTMLAppearance?.shutdown();
  askGPTInlineScope?.instance?.shutdown();
  askGPTInlineScope = null;
}
function install() {}
function uninstall() {}
