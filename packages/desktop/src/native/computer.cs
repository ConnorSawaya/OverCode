using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// A local, persistent stdio worker. It has no socket or arbitrary code endpoint.
internal static class ComputerWorker {
  [StructLayout(LayoutKind.Sequential)] struct Mouse { public int x, y; public uint data, flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct Keyboard { public ushort key, scan; public uint flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct Data { [FieldOffset(0)] public Mouse mouse; [FieldOffset(0)] public Keyboard keyboard; }
  [StructLayout(LayoutKind.Sequential)] struct Input { public uint type; public Data data; }
  [StructLayout(LayoutKind.Sequential)] struct Point { public int x, y; }
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, Input[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };
  static readonly List<ushort> HeldKeys = new List<ushort>();
  static uint HeldMouse;

  [STAThread] static void Main() {
    Console.InputEncoding = new System.Text.UTF8Encoding(false);
    Console.OutputEncoding = new System.Text.UTF8Encoding(false);
    SetProcessDpiAwarenessContext(new IntPtr(-4));
    string line;
    try {
      while ((line = Console.ReadLine()) != null) {
        string id = "";
        try {
          var request = Json.Deserialize<Dictionary<string, object>>(line);
          id = Text(request, "id");
          Console.WriteLine(Json.Serialize(new { id = id, result = Execute(request) }));
        } catch (Exception error) {
          Release();
          Console.WriteLine(Json.Serialize(new { id = id, error = error.Message }));
        }
      }
    } finally { Release(); }
  }

  static string Text(Dictionary<string, object> r, string key, string fallback = "") {
    object value; return r.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : fallback;
  }
  static int Number(Dictionary<string, object> r, string key, int fallback = 0) {
    object value; return r.TryGetValue(key, out value) && value != null ? Convert.ToInt32(value) : fallback;
  }
  static void Send(params Input[] inputs) {
    if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input))) != inputs.Length)
      throw new InvalidOperationException("Windows could not deliver input to this application");
  }
  static Input Key(ushort key, bool up, bool unicode = false) {
    return new Input { type = 1, data = new Data { keyboard = new Keyboard {
      key = unicode ? (ushort)0 : key, scan = unicode ? key : (ushort)0,
      flags = (up ? 2u : 0u) | (unicode ? 4u : 0u) } } };
  }
  static void MouseEvent(uint flags, int amount = 0) {
    Send(new Input { type = 0, data = new Data { mouse = new Mouse { flags = flags, data = unchecked((uint)amount) } } });
  }
  static void Release() {
    foreach (var key in HeldKeys) { try { Send(Key(key, true)); } catch {} }
    HeldKeys.Clear();
    if (HeldMouse != 0) { try { MouseEvent(HeldMouse); } catch {} HeldMouse = 0; }
  }
  static ushort KeyCode(string value) {
    switch (value.ToLowerInvariant()) {
      case "ctrl": case "control": case "control_l": return 0x11;
      case "alt": case "alt_l": return 0x12;
      case "shift": case "shift_l": return 0x10;
      case "win": case "meta": case "super": return 0x5b;
      case "enter": case "return": return 0x0d;
      case "tab": return 0x09;
      case "escape": case "esc": return 0x1b;
      case "backspace": return 0x08;
      case "delete": return 0x2e;
      case "space": return 0x20;
      case "left": return 0x25; case "up": return 0x26; case "right": return 0x27; case "down": return 0x28;
      case "home": return 0x24; case "end": return 0x23;
      case "pageup": return 0x21; case "pagedown": return 0x22;
    }
    if (value.Length == 1 && Char.IsLetterOrDigit(value[0])) return (ushort)Char.ToUpperInvariant(value[0]);
    int f; if (value.StartsWith("F", StringComparison.OrdinalIgnoreCase) && Int32.TryParse(value.Substring(1), out f) && f >= 1 && f <= 24) return (ushort)(0x6f + f);
    throw new ArgumentException("Unsupported key: " + value);
  }

  static object Execute(Dictionary<string, object> r) {
    var action = Text(r, "action");
    var screens = Screen.AllScreens;
    var display = Number(r, "display");
    if (display < 0 || display >= screens.Length) throw new ArgumentException("Display no longer available");
    var bounds = screens[display].Bounds;
    if (action == "screenshot") return Capture(bounds, display, screens.Length);
    var expected = r["bounds"] as Dictionary<string, object>;
    if (expected == null || Number(expected, "x") != bounds.X || Number(expected, "y") != bounds.Y || Number(expected, "width") != bounds.Width || Number(expected, "height") != bounds.Height)
      throw new InvalidOperationException("Display layout changed; take a new screenshot");
    if (Text(r, "foreground") != GetForegroundWindow().ToInt64().ToString())
      throw new InvalidOperationException("Focused window changed; take a new screenshot");
    int x = Number(r, "x"), y = Number(r, "y");
    if (action == "move" || action == "click" || action == "doubleClick" || action == "drag" || action == "scroll") {
      if (!bounds.Contains(x, y)) throw new ArgumentException("Point is outside the display");
      if (!SetCursorPos(x, y)) throw new InvalidOperationException("Cannot move cursor on this desktop");
    }
    if (action == "click" || action == "doubleClick" || action == "drag") {
      var button = Text(r, "button", "left");
      uint down = button == "right" ? 8u : button == "middle" ? 32u : 2u;
      uint up = down * 2;
      try {
        int clicks = action == "doubleClick" ? 2 : 1;
        for (int c = 0; c < clicks; c++) {
          HeldMouse = up; MouseEvent(down);
          if (action == "drag") {
            int endX = Number(r, "endX"), endY = Number(r, "endY");
            if (!bounds.Contains(endX, endY)) throw new ArgumentException("Drag end is outside the display");
            for (int i = 1; i <= 12; i++) { SetCursorPos(x + (endX - x) * i / 12, y + (endY - y) * i / 12); Thread.Sleep(8); }
          }
          MouseEvent(up); HeldMouse = 0;
          if (clicks > 1) Thread.Sleep(40);
        }
      } finally { Release(); }
    } else if (action == "scroll") {
      var direction = Text(r, "direction", "down");
      var amount = Math.Min(2400, Math.Max(0, Number(r, "amount", 480)));
      var horizontal = direction == "left" || direction == "right";
      MouseEvent(horizontal ? 0x1000u : 0x800u, (direction == "down" || direction == "left") ? -amount : amount);
    } else if (action == "type") {
      var value = Text(r, "text");
      if (value.Length > 8000) throw new ArgumentException("Text is too long");
      var inputs = new List<Input>();
      foreach (char ch in value) { inputs.Add(Key(ch, false, true)); inputs.Add(Key(ch, true, true)); }
      if (inputs.Count > 0) Send(inputs.ToArray());
    } else if (action == "press") {
      var keys = new List<ushort>();
      foreach (var name in Text(r, "key").Split('+')) keys.Add(KeyCode(name.Trim()));
      if (keys.Count > 6) throw new ArgumentException("Too many keys");
      // Deliver the chord atomically so cancellation cannot leave a modifier held.
      var inputs = new List<Input>();
      foreach (var key in keys) { HeldKeys.Add(key); inputs.Add(Key(key, false)); }
      keys.Reverse(); foreach (var key in keys) inputs.Add(Key(key, true));
      try { Send(inputs.ToArray()); } finally { Release(); }
    } else if (action != "move") throw new ArgumentException("Unknown computer action");
    Thread.Sleep(35);
    return new { ok = true };
  }

  static object Capture(Rectangle bounds, int display, int displays) {
    var scale = Math.Min(1.0, 1280.0 / bounds.Width);
    int width = (int)Math.Round(bounds.Width * scale), height = (int)Math.Round(bounds.Height * scale);
    using (var full = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format24bppRgb))
    using (var graphics = Graphics.FromImage(full))
    using (var small = new Bitmap(width, height))
    using (var output = Graphics.FromImage(small))
    using (var stream = new MemoryStream()) {
      graphics.CopyFromScreen(bounds.Location, System.Drawing.Point.Empty, bounds.Size);
      output.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBilinear;
      output.DrawImage(full, new Rectangle(0, 0, width, height));
      ImageCodecInfo codec = null;
      foreach (var candidate in ImageCodecInfo.GetImageEncoders()) if (candidate.MimeType == "image/jpeg") codec = candidate;
      using (var parameters = new EncoderParameters(1)) {
        parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 65L);
        small.Save(stream, codec, parameters);
      }
      Point cursor; GetCursorPos(out cursor);
      return new { data = Convert.ToBase64String(stream.ToArray()), mime = "image/jpeg", width = width, height = height,
        display = display, displays = displays, bounds = new { x = bounds.X, y = bounds.Y, width = bounds.Width, height = bounds.Height },
        foreground = GetForegroundWindow().ToInt64().ToString(), cursor = new { x = (cursor.x - bounds.X) * scale, y = (cursor.y - bounds.Y) * scale } };
    }
  }
}
