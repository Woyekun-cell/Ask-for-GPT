/* WPS creates index.html and imports this classic script from the local add-in directory. */
var AskGPTWritingPane = null;
function AskGPTWritingOpen() {
  var application = typeof Application !== 'undefined' ? Application : wps;
  if (!AskGPTWritingPane) AskGPTWritingPane = application.CreateTaskPane('https://localhost:43793/shared/taskpane.html?host=wps', '写作检查');
  if (!AskGPTWritingPane) throw new Error('WPS 无法打开写作检查任务窗；请检查本机 HTTPS 服务与证书信任。');
  AskGPTWritingPane.Visible = true;
}
