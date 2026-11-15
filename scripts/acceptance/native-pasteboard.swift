// Preserve every pasteboard format; restore only while fixture text still owns it.
import Cocoa
let path = CommandLine.arguments[2]
let board = NSPasteboard.general
if CommandLine.arguments[1] == "save" {
    let items = board.pasteboardItems?.map { item -> [String:String] in
        var formats: [String:String] = [:]
        for type in item.types { if let data = item.data(forType:type) { formats[type.rawValue] = data.base64EncodedString() } }
        return formats
    } ?? []
    try JSONSerialization.data(withJSONObject:items).write(to:URL(fileURLWithPath:path))
} else {
    let allowed = Array(CommandLine.arguments.dropFirst(3))
    guard let current = board.string(forType:.string), allowed.contains(current) else {
        print("Clipboard changed externally or fixture never wrote; original snapshot retained")
        exit(0)
    }
    let saved = try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:path))) as! [[String:String]]
    let items = saved.map { formats -> NSPasteboardItem in
        let item = NSPasteboardItem()
        for (type,encoded) in formats { item.setData(Data(base64Encoded:encoded)!,forType:NSPasteboard.PasteboardType(type)) }
        return item
    }
    board.clearContents()
    if !items.isEmpty { board.writeObjects(items) }
    print("Original clipboard formats restored")
}
