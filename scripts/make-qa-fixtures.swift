import AppKit
import PDFKit

let destination = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("work/qa-fixtures", isDirectory: true)
try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
let alpha = "ALPHA-742. The experiment compared two groups of samples and measured gene expression at two time points."
let beta = "BETA-905. A technical replicate measures the same sample again. It is not an independent biological replicate."
let html = """
<!doctype html><html lang="en"><meta charset="utf-8"><title>Ask for GPT public selection test</title>
<style>body{font:22px/1.6 system-ui;max-width:780px;margin:70px auto;padding:20px;color:#20242b}h1{font-size:28px}p{margin:40px 0}small{font-size:14px;color:#68707c}</style>
<h1>Public selection test</h1><small>Synthetic sentences for browser and PDF UI verification.</small><p>\(alpha)</p><p>\(beta)</p></html>
"""
try html.write(to: destination.appendingPathComponent("public-selection.html"), atomically: true, encoding: .utf8)
let pdfURL = destination.appendingPathComponent("public-selection.pdf")
var page = CGRect(x: 0, y: 0, width: 612, height: 792)
guard let context = CGContext(pdfURL as CFURL, mediaBox: &page, nil) else { fatalError("Cannot create QA PDF") }
context.beginPDFPage(nil)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
NSAttributedString(string: "Public selection test", attributes: [.font: NSFont.boldSystemFont(ofSize: 24)]).draw(at: CGPoint(x: 50, y: 720))
NSAttributedString(string: "Synthetic sentences for reader verification.", attributes: [.font: NSFont.systemFont(ofSize: 12)]).draw(at: CGPoint(x: 50, y: 690))
NSAttributedString(string: alpha, attributes: [.font: NSFont.systemFont(ofSize: 18)]).draw(in: CGRect(x: 50, y: 545, width: 512, height: 105))
NSAttributedString(string: beta, attributes: [.font: NSFont.systemFont(ofSize: 18)]).draw(in: CGRect(x: 50, y: 395, width: 512, height: 105))
NSGraphicsContext.restoreGraphicsState()
context.endPDFPage(); context.closePDF()
let text = PDFDocument(url: pdfURL)?.string?.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
guard let text, text.contains(alpha), text.contains(beta) else { fatalError("QA PDF text verification failed") }
print("QA_FIXTURES_READY selectable_pdf_text=true " + destination.path)
