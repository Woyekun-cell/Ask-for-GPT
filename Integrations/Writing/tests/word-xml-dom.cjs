// Native DOMParser boundary for Node tests. Python's standard XML parser supplies
// namespace-aware nodes; no production XML parsing rules are mirrored here.
const {spawnSync} = require('node:child_process');
const PARSE = `import json,sys,xml.etree.ElementTree as ET
def node(e):
 ns,local=e.tag[1:].split('}',1) if e.tag.startswith('{') else ('',e.tag)
 return {'ns':ns,'local':local,'attributes':e.attrib,'text':''.join(e.itertext()),'ownText':e.text or '', 'tail':e.tail or '', 'children':[node(c) for c in e]}
try: print(json.dumps(node(ET.fromstring(sys.stdin.read()))))
except ET.ParseError: print(json.dumps({'ns':'http://www.mozilla.org/newlayout/xml/parsererror.xml','local':'parsererror','attributes':{},'text':'Invalid XML','ownText':'Invalid XML','tail':'','children':[]}))
`;
function element(value) {
  const children = value.children.map(element);
  const attributes=Object.entries(value.attributes).map(([name,value])=>{const match=name.match(/^\{([^}]+)\}(.+)$/);return {namespaceURI:match?match[1]:null,localName:match?match[2]:name,value};});
  const node = {nodeType:1, namespaceURI:value.ns, localName:value.local, textContent:value.text, children, attributes,
    getAttributeNS(namespace, name) {return value.attributes[namespace ? `{${namespace}}${name}` : name] ?? null;},
    getElementsByTagNameNS(namespace, name) {return children.flatMap(child => [(namespace==='*'||child.namespaceURI===namespace)&&(name==='*'||child.localName===name)?child:null,...child.getElementsByTagNameNS(namespace,name)]).filter(Boolean);}};
  node.childNodes = [...(value.ownText ? [{nodeType:3,textContent:value.ownText}] : []),...children.flatMap((child,index) => [child,...(value.children[index].tail ? [{nodeType:3,textContent:value.children[index].tail}] : [])])];
  return node;
}
class XMLParser {
  parseFromString(xml) {
    const result=spawnSync('python3',['-c',PARSE],{input:xml,encoding:'utf8',maxBuffer:2_000_000});
    if(result.status!==0)throw new Error(result.stderr||'XML test parser unavailable');
    const root=element(JSON.parse(result.stdout));
    return {documentElement:root,getElementsByTagNameNS(namespace,name) {return [(namespace==='*'||root.namespaceURI===namespace)&&(name==='*'||root.localName===name)?root:null,...root.getElementsByTagNameNS(namespace,name)].filter(Boolean);}};
  }
}
module.exports={XMLParser};
