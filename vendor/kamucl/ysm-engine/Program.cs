using System.Text.Json;
using YSMViewer.Services;
using YSMViewer.Browser.Rendering.ThreeJs;
try {
 if (args.Length != 2) throw new ArgumentException("Expected model file and output file");
 var doc = YsmLoaderService.LoadDocumentFromFile(args[0]);
 var payload = new { engine = "ysmviewer-1", spec = ThreeJsPayloadBuilder.BuildSpecJson(doc), textures = doc.Textures.Select(t => new { id=t.Id, name=t.Name, png=Convert.ToBase64String(t.Data) }), animations = doc.Animations.Select(a => System.Text.Encoding.UTF8.GetString(a.Data)) };
 File.WriteAllText(args[1], JsonSerializer.Serialize(payload));
} catch(Exception e) { Console.Error.WriteLine(e.Message); Environment.ExitCode=1; }
