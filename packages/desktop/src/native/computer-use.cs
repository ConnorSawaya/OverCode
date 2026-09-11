// Standalone .NET Framework / C# 5 helper. Stdout is exclusively JSON-lines.
// The STA owns visibility and physical Escape; no input job runs on its message pump.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace Overcode.ComputerUse
{
    internal sealed class Failure : Exception
    {
        internal readonly bool Fatal;
        internal Failure(string code, bool fatal = false) : base(code) { Fatal = fatal; }
    }

    internal static class Program
    {
        internal static readonly Stopwatch Clock = Stopwatch.StartNew();

        [STAThread]
        private static int Main(string[] args)
        {
            Console.InputEncoding = new UTF8Encoding(false, true);
            Console.OutputEncoding = new UTF8Encoding(false);
            try
            {
                bool dpi = Native.EnableDpi();
                if (args.Length == 1 && args[0] == "--check")
                {
                    // No window, hook, capture, cursor movement, or SendInput in this branch.
                    Write(new { id = "check", ok = true, result = Native.Check(dpi) });
                    return 0;
                }
                if ((args.Length == 2 || args.Length == 3) && args[0] == "--preview-image")
                {
                    Write(new { id = "preview-image", ok = true, result = Overlay.Preview(args[1], Request.ColorValue(args.Length == 3 ? args[2] : "#23b7a5")) });
                    return 0;
                }
                if (args.Length > 1 || (args.Length == 1 && args[0] != "--self-test"))
                    throw new Failure("invalid_arguments");
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
                using (Host host = new Host(dpi)) return host.Run(args.Length == 1);
            }
            catch (Exception error)
            {
                Write(new { id = "startup", ok = false, error = error is Failure ? error.Message : "native_startup_failed" });
                return 1;
            }
        }

        internal static void Write(object value)
        {
            Console.WriteLine(new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 }.Serialize(value));
            Console.Out.Flush();
        }
    }

    internal sealed class Request
    {
        internal string Id;
        internal string Action;
        internal Dictionary<string, object> Data;

        internal static Request Parse(string line)
        {
            Dictionary<string, object> data;
            try
            {
                data = new JavaScriptSerializer { MaxJsonLength = 65536, RecursionLimit = 8 }
                    .DeserializeObject(line) as Dictionary<string, object>;
            }
            catch { throw new Failure("invalid_json"); }
            if (data == null) throw new Failure("invalid_request");
            Request request = new Request { Data = data };
            request.Id = request.Text("id", 128);
            request.Action = request.Text("action", 32);
            return request;
        }

        internal string Text(string name, int maximum, bool optional = false)
        {
            object value;
            if (!Data.TryGetValue(name, out value) && optional) return null;
            string text = value as string;
            if (String.IsNullOrWhiteSpace(text) || text.Length > maximum) throw new Failure("invalid_" + name);
            return text;
        }

        internal double Number(string name, double minimum, double maximum)
        {
            object value;
            if (!Data.TryGetValue(name, out value) || !(value is int || value is long || value is decimal || value is double))
                throw new Failure("invalid_" + name);
            double number = Convert.ToDouble(value, CultureInfo.InvariantCulture);
            if (Double.IsNaN(number) || Double.IsInfinity(number) || number < minimum || number > maximum)
                throw new Failure("invalid_" + name);
            return number;
        }

        internal static Color ColorValue(string value)
        {
            uint rgb;
            if (value == null || value.Length != 7 || value[0] != '#' ||
                !UInt32.TryParse(value.Substring(1), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out rgb))
                throw new Failure("invalid_color");
            return Color.FromArgb(255, (int)(rgb >> 16), (int)((rgb >> 8) & 255), (int)(rgb & 255));
        }
    }

    internal sealed class Display
    {
        internal IntPtr Monitor;
        internal Rectangle Bounds;
        internal Rectangle Virtual;
        internal uint Dpi;
        internal string Signature;
    }

    internal sealed class Frame
    {
        internal string Id;
        internal long Created;
    }

    internal sealed class Session
    {
        internal long Generation;
        internal long Deadline;
        internal Display Display;
        internal Frame Frame;
        internal IntPtr Border;
        internal IntPtr Halo;
        internal IntPtr Pill;
    }

    internal sealed class Job
    {
        internal Request Request;
        internal Session Session;
        internal bool SelfTest;
    }

    internal sealed class Held
    {
        internal Native.INPUT Up;
    }

    internal sealed class Host : IDisposable
    {
        private const long LeaseMs = 10 * 60 * 1000;
        private const long IdleMs = 2 * 60 * 1000;
        private const long FrameMs = 2 * 60 * 1000;
        private readonly bool dpi;
        private readonly object stateGate = new object();
        private readonly object inputGate = new object();
        private readonly BlockingCollection<Job> jobs = new BlockingCollection<Job>(32);
        private readonly BlockingCollection<object> output = new BlockingCollection<object>(128);
        private readonly List<Held> held = new List<Held>();
        private readonly List<string> stopWaiters = new List<string>();
        private readonly Dispatcher ui;
        private readonly ApplicationContext context = new ApplicationContext();
        private readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer { Interval = 33 };
        private readonly Native.HookProc hookCallback;
        private IntPtr hook;
        private Overlay border;
        private Overlay halo;
        private Overlay pill;
        // 0 idle, 1 starting, 2 active, 3 stopping. Never hold stateGate over a Win32 call.
        private volatile int state;
        private long generation;
        private Session session;
        private bool cleaning;
        private bool shutdown;
        private bool disposed;
        private bool registered;
        private string stoppedReason;
        private int exitCode;
        private long activity = Program.Clock.ElapsedMilliseconds;
        private long heartbeat = Program.Clock.ElapsedMilliseconds;
        private long health;
        private Thread writer;
        private System.Threading.Timer watchdog;
        private Fixture fixture;
        private long screenshots;
        private long injections;
        private int injectedEscapes;

        internal Host(bool dpi)
        {
            this.dpi = dpi;
            ui = new Dispatcher(this);
            IntPtr handle = ui.Handle;
            registered = Native.WTSRegisterSessionNotification(handle, 0);
            hookCallback = KeyboardHook;
            timer.Tick += Tick;
            Application.ThreadException += ThreadError;
        }

        internal int Run(bool selfTest)
        {
            writer = new Thread(delegate()
            {
                try { foreach (object value in output.GetConsumingEnumerable()) Program.Write(value); }
                catch { RequestStop("stdout_closed", null, true); }
            }) { IsBackground = true, Name = "computer-use-json-output" };
            writer.Start();
            new Thread(Work) { IsBackground = true, Name = "computer-use-actions" }.Start();
            timer.Start();
            watchdog = new System.Threading.Timer(delegate
            {
                long now = Program.Clock.ElapsedMilliseconds;
                Session owner;
                lock (stateGate) { owner = state == 2 ? session : null; }
                if (now - Interlocked.Read(ref activity) >= IdleMs) RequestStop("idle_timeout", null, true);
                if (owner == null) return;
                if (now >= owner.Deadline) RequestStop("lease_expired", null, false);
                if (now - Interlocked.Read(ref heartbeat) > 750) RequestStop("overlay_unresponsive", null, true);
            }, null, 100, 100);
            Emit(new { @event = "ready" });
            if (selfTest) ui.BeginInvoke(new Action(BeginSelfTest));
            if (!selfTest) new Thread(Read) { IsBackground = true, Name = "computer-use-json-input" }.Start();
            Application.Run(context);
            output.CompleteAdding();
            writer.Join(1500);
            return exitCode;
        }

        private void Emit(object value)
        {
            if (output.IsAddingCompleted) return;
            try { if (output.TryAdd(value)) return; }
            catch (InvalidOperationException) { return; }
            RequestStop("output_backpressure", null, true);
        }

        private void Reply(string id, object result) { Emit(new { id = id, ok = true, result = result }); }
        private void Reject(string id, string error) { Emit(new { id = id ?? "", ok = false, error = error }); }

        private void Read()
        {
            try
            {
                while (true)
                {
                    // ReadLine alone would permit unbounded allocations from a broken peer.
                    StringBuilder line = new StringBuilder();
                    bool overflow = false;
                    int character;
                    while ((character = Console.In.Read()) != -1 && character != '\n')
                    {
                        if (line.Length < 65536) line.Append((char)character);
                        else overflow = true;
                    }
                    if (character == -1) { RequestStop("stdin_eof", null, true); return; }
                    if (overflow) { Reject("", "request_too_large"); continue; }
                    Request request = null;
                    try
                    {
                        request = Request.Parse(line.ToString());
                        if (request.Action == "stop") { RequestStop("requested", request.Id, false); continue; }
                        if (request.Action == "start")
                        {
                            long ticket;
                            lock (stateGate)
                            {
                                if (shutdown) throw new Failure("shutting_down");
                                if (state != 0) throw new Failure(state == 3 ? "session_stopping" : "already_active");
                                state = 1;
                                ticket = ++generation;
                            }
                            Touch();
                            Request start = request;
                            ui.BeginInvoke(new Action(delegate { Start(start, ticket); }));
                            continue;
                        }
                        if (request.Action == "color")
                        {
                            Color color = Request.ColorValue(request.Text("color", 7));
                            Session owner = Current();
                            Request change = request;
                            ui.BeginInvoke(new Action(delegate
                            {
                                try
                                {
                                    Guard(new Job { Request = change, Session = owner }, false);
                                    border.Recolor(color);
                                    halo.Recolor(color);
                                    pill.Recolor(color);
                                    Touch();
                                    Reply(change.Id, new { color = change.Text("color", 7) });
                                }
                                catch (Exception error) { Failed(change.Id, error); }
                            }));
                            continue;
                        }
                        if (!new[] { "screenshot", "move", "click", "doubleClick", "drag", "scroll", "type", "press" }.Contains(request.Action))
                            throw new Failure("unknown_action");
                        Job job = new Job { Request = request, Session = Current() };
                        if (!jobs.TryAdd(job)) throw new Failure("queue_full");
                    }
                    catch (Exception error) { Failed(request == null ? "" : request.Id, error); }
                }
            }
            catch { RequestStop("stdin_failed", null, true); }
        }

        private Session Current()
        {
            lock (stateGate)
            {
                if (state != 2 || session == null) throw new Failure("inactive");
                return session;
            }
        }

        private void Start(Request request, long ticket)
        {
            try
            {
                lock (stateGate)
                    if (state != 1 || generation != ticket || shutdown) throw new Failure("cancelled");
                Native.RequireCapabilities(dpi);
                if (!registered) throw new Failure("session_notifications_unavailable", true);
                Color color = Request.ColorValue(request.Text("color", 7, true) ?? "#23b7a5");
                object value;
                Dictionary<string, object> labels;
                if (!request.Data.TryGetValue("labels", out value) || (labels = value as Dictionary<string, object>) == null)
                    throw new Failure("invalid_labels");
                Request copy = new Request { Data = labels };
                string[] text = new[] { copy.Text("active", 240), copy.Text("stop", 80), copy.Text("escape", 80) };
                if (text.Any(label => label.Any(Char.IsControl))) throw new Failure("invalid_labels");
                Native.POINT cursor;
                if (!Native.GetCursorPos(out cursor)) throw new Failure("cursor_unavailable", true);
                Display display = Native.GetDisplay(Native.MonitorFromPoint(cursor, 2));
                Session next = new Session { Generation = ticket, Display = display };
                border = new Overlay(0, display, color, text, delegate { RequestStop("overlay_closed", null, false); });
                halo = new Overlay(1, display, color, text, delegate { RequestStop("overlay_closed", null, false); });
                pill = new Overlay(2, display, color, text, delegate { RequestStop("user_stop", null, false); });
                border.Reveal();
                halo.Follow(cursor);
                halo.Reveal();
                pill.Reveal();
                hook = Native.SetWindowsHookEx(13, hookCallback, Native.GetModuleHandle(null), 0);
                if (hook == IntPtr.Zero) throw new Failure("escape_hook_unavailable", true);
                if (Native.DwmFlush() != 0) throw new Failure("overlay_unavailable", true);
                next.Border = border.Handle;
                next.Halo = halo.Handle;
                next.Pill = pill.Handle;
                IntPtr foreground = Native.GetForegroundWindow();
                if (foreground == next.Border || foreground == next.Halo || foreground == next.Pill)
                    throw new Failure("overlay_activated", true);
                if (!Native.IsWindowVisible(next.Border) || !Native.IsWindowVisible(next.Halo) || !Native.IsWindowVisible(next.Pill))
                    throw new Failure("overlay_unavailable", true);
                if (Native.GetDisplay(display.Monitor).Signature != display.Signature)
                    throw new Failure("display_changed", true);
                lock (stateGate)
                {
                    if (state != 1 || generation != ticket || shutdown) throw new Failure("cancelled");
                    next.Deadline = Program.Clock.ElapsedMilliseconds + LeaseMs;
                    session = next;
                    state = 2;
                }
                Interlocked.Exchange(ref heartbeat, Program.Clock.ElapsedMilliseconds);
                Touch();
                Reply(request.Id, new
                {
                    bounds = new { x = display.Bounds.X, y = display.Bounds.Y, width = display.Bounds.Width, height = display.Bounds.Height },
                    dpi = display.Dpi,
                    leaseMs = LeaseMs,
                    idleTimeoutMs = IdleMs,
                    frameMaxAgeMs = FrameMs
                });
            }
            catch (Exception error)
            {
                RequestStop(error is Failure ? error.Message : "overlay_unavailable", null, false);
                Reject(request.Id, error is Failure ? error.Message : "native_start_failed");
            }
        }

        internal void RequestStop(string reason, string id, bool exit)
        {
            lock (stateGate)
            {
                if (disposed) return;
                shutdown |= exit;
                if (id != null) stopWaiters.Add(id);
                if (state == 1 || state == 2)
                {
                    state = 3;
                    ++generation;
                    if (session != null) session.Frame = null;
                    stoppedReason = reason;
                }
                if (cleaning) return;
                state = 3;
                cleaning = true;
            }
            // Never wait for SendInput in the low-level hook or STA: SendInput itself
            // can wait for this thread to dispatch an injected keyboard-hook callback.
            ThreadPool.QueueUserWorkItem(delegate
            {
                bool released;
                lock (inputGate) released = ReleaseAll();
                try
                {
                    ui.BeginInvoke(new Action(delegate
                    {
                        if (hook != IntPtr.Zero) { Native.UnhookWindowsHookEx(hook); hook = IntPtr.Zero; }
                        if (border != null) { border.CloseSafely(); border = null; }
                        if (halo != null) { halo.CloseSafely(); halo = null; }
                        if (pill != null) { pill.CloseSafely(); pill = null; }
                        string[] waiters;
                        string stopped;
                        bool quit;
                        lock (stateGate)
                        {
                            if (!released) { shutdown = true; exitCode = 1; }
                            state = 0;
                            session = null;
                            cleaning = false;
                            stopped = stoppedReason;
                            stoppedReason = null;
                            waiters = stopWaiters.ToArray();
                            stopWaiters.Clear();
                            quit = shutdown;
                        }
                        if (stopped != null) Emit(new { @event = "stopped", reason = released ? stopped : "input_release_failed" });
                        foreach (string waiter in waiters)
                        {
                            if (released) Reply(waiter, new { stopped = true });
                            if (!released) Reject(waiter, "input_release_failed");
                        }
                        if (quit) { timer.Stop(); context.ExitThread(); }
                        if (!quit) Touch();
                    }));
                }
                catch { Environment.Exit(1); }
            });
        }

        private IntPtr KeyboardHook(int code, IntPtr message, IntPtr pointer)
        {
            if (code >= 0 && (message.ToInt64() == 0x100 || message.ToInt64() == 0x104))
            {
                Native.KBDLLHOOKSTRUCT key = (Native.KBDLLHOOKSTRUCT)Marshal.PtrToStructure(pointer, typeof(Native.KBDLLHOOKSTRUCT));
                if (key.vkCode == 0x1B && (key.flags & 0x12) != 0) Interlocked.Increment(ref injectedEscapes);
                if (key.vkCode == 0x1B && (key.flags & 0x12) == 0 && (state == 1 || state == 2))
                {
                    RequestStop("escape", null, false);
                    return new IntPtr(1);
                }
            }
            return Native.CallNextHookEx(hook, code, message, pointer);
        }

        private void Tick(object sender, EventArgs args)
        {
            long now = Program.Clock.ElapsedMilliseconds;
            Interlocked.Exchange(ref heartbeat, now);
            if (now - Interlocked.Read(ref activity) >= IdleMs) { RequestStop("idle_timeout", null, true); return; }
            Session owner;
            lock (stateGate) { owner = state == 2 ? session : null; }
            if (owner == null) return;
            try
            {
                if (now >= owner.Deadline) { RequestStop("lease_expired", null, false); return; }
                Native.POINT point;
                if (!Native.GetCursorPos(out point)) throw new Failure("cursor_unavailable", true);
                halo.Follow(point);
                if (now - health < 250) return;
                health = now;
                Guard(new Job { Session = owner }, false);
                border.KeepOnTop();
                halo.KeepOnTop();
                pill.KeepOnTop();
            }
            catch (Exception error) { RequestStop(error is Failure ? error.Message : "overlay_unavailable", null, false); }
        }

        private void Guard(Job job, bool frame)
        {
            long now = Program.Clock.ElapsedMilliseconds;
            lock (stateGate)
            {
                if (state != 2 || session != job.Session || generation != job.Session.Generation)
                    throw new Failure("cancelled");
                if (now >= session.Deadline) throw new Failure("lease_expired", true);
                if (frame)
                {
                    string id = job.Request.Text("frameId", 128);
                    if (session.Frame == null || session.Frame.Id != id) throw new Failure("stale_frame");
                    if (now - session.Frame.Created > FrameMs) throw new Failure("stale_frame");
                }
            }
            if (now - Interlocked.Read(ref heartbeat) > 750 || hook == IntPtr.Zero ||
                !Native.IsWindowVisible(job.Session.Border) || !Native.IsWindowVisible(job.Session.Halo) || !Native.IsWindowVisible(job.Session.Pill))
                throw new Failure("overlay_unavailable", true);
            if (!Native.InteractiveDesktop()) throw new Failure("desktop_unavailable", true);
            if (Native.GetDisplay(job.Session.Display.Monitor).Signature != job.Session.Display.Signature)
                throw new Failure("display_changed", true);
            if (fixture != null) fixture.RequireIdentity();
            // Session/desktop queries can take time. Recheck revocation *after* them,
            // immediately before the caller can issue a single SendInput event.
            lock (stateGate)
            {
                if (state != 2 || session != job.Session || generation != job.Session.Generation) throw new Failure("cancelled");
                now = Program.Clock.ElapsedMilliseconds;
                if (now >= session.Deadline) throw new Failure("lease_expired", true);
                if (now - Interlocked.Read(ref heartbeat) > 750) throw new Failure("overlay_unresponsive", true);
                if (frame && (session.Frame == null || now - session.Frame.Created > FrameMs)) throw new Failure("stale_frame");
            }
        }

        private void Touch() { Interlocked.Exchange(ref activity, Program.Clock.ElapsedMilliseconds); }

        private void Work()
        {
            foreach (Job job in jobs.GetConsumingEnumerable())
            {
                if (job.SelfTest) { SelfTest(job); continue; }
                try
                {
                    object result = job.Request.Action == "screenshot" ? Screenshot(job) : Input(job);
                    Guard(job, job.Request.Action != "screenshot");
                    Touch();
                    Reply(job.Request.Id, result);
                }
                catch (Exception error) { Failed(job.Request.Id, error); }
            }
        }

        private void Failed(string id, Exception error)
        {
            Failure failure = error as Failure;
            if (failure == null || failure.Fatal) RequestStop(failure == null ? "native_failure" : failure.Message, null, false);
            Reject(id, failure == null ? "native_failure" : failure.Message);
        }

        private object Screenshot(Job job)
        {
            Guard(job, false);
            Rectangle bounds = job.Session.Display.Bounds;
            double ratio = Math.Min(1.0, Math.Min(1280.0 / bounds.Width, 720.0 / bounds.Height));
            int width = Math.Max(1, (int)Math.Floor(bounds.Width * ratio));
            int height = Math.Max(1, (int)Math.Floor(bounds.Height * ratio));
            long created = Program.Clock.ElapsedMilliseconds;
            string data;
            using (Bitmap capture = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppRgb))
            using (Bitmap resized = new Bitmap(width, height, PixelFormat.Format24bppRgb))
            {
                using (Graphics graphics = Graphics.FromImage(capture))
                    graphics.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size, CopyPixelOperation.SourceCopy);
                Interlocked.Increment(ref screenshots);
                Guard(job, false);
                using (Graphics graphics = Graphics.FromImage(resized))
                {
                    graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    graphics.DrawImage(capture, new Rectangle(0, 0, width, height));
                }
                using (MemoryStream stream = new MemoryStream())
                using (EncoderParameters parameters = new EncoderParameters(1))
                {
                    parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 80L);
                    resized.Save(stream, ImageCodecInfo.GetImageEncoders().First(codec => codec.MimeType == "image/jpeg"), parameters);
                    data = Convert.ToBase64String(stream.ToArray());
                }
            }
            Guard(job, false);
            Frame frame = new Frame { Id = Guid.NewGuid().ToString("N"), Created = created };
            lock (stateGate)
            {
                if (state != 2 || session != job.Session || generation != job.Session.Generation) throw new Failure("cancelled");
                session.Frame = frame;
            }
            return new { frame = new { id = frame.Id, data = data, mime = "image/jpeg", width = width, height = height } };
        }

        private object Input(Job job)
        {
            Request request = job.Request;
            Guard(job, true);
            // Do not combine the user's physically held modifiers/buttons with our job.
            foreach (int key in new[] { 1, 2, 4, 5, 6, 0x10, 0x11, 0x12, 0x5B, 0x5C })
                if ((Native.GetAsyncKeyState(key) & 0x8000) != 0) throw new Failure("physical_input_held");
            if (request.Action == "type")
            {
                object value;
                string text;
                if (!request.Data.TryGetValue("text", out value) || (text = value as string) == null || text.Length == 0 || text.Length > 2000)
                    throw new Failure("invalid_text");
                for (int i = 0; i < text.Length; i++)
                {
                    if (Char.IsControl(text[i]) && text[i] != '\r' && text[i] != '\n' && text[i] != '\t') throw new Failure("invalid_text");
                    if (Char.IsLowSurrogate(text[i])) throw new Failure("invalid_text");
                    if (Char.IsHighSurrogate(text[i]) && (++i == text.Length || !Char.IsLowSurrogate(text[i]))) throw new Failure("invalid_text");
                }
                foreach (char character in text.Replace("\r\n", "\n"))
                {
                    ushort vk = character == '\r' || character == '\n' ? (ushort)13 : character == '\t' ? (ushort)9 : (ushort)0;
                    Native.INPUT down = Native.Key(vk, vk == 0 ? character : (ushort)0, vk == 0 ? 4u : 0u);
                    Stroke(job, down, Native.Key(vk, vk == 0 ? character : (ushort)0, vk == 0 ? 6u : 2u), 0);
                    Pause(job, 2);
                }
                return new { action = request.Action, ok = true };
            }
            if (request.Action == "press")
            {
                ushort[] chord = ParseChord(request.Text("key", 80));
                foreach (ushort key in chord)
                    if ((Native.GetAsyncKeyState(key) & 0x8000) != 0) throw new Failure("physical_input_held");
                List<Held> keys = new List<Held>();
                try
                {
                    foreach (ushort key in chord)
                    {
                        uint flags = key >= 0x21 && key <= 0x2E ? 1u : 0u;
                        keys.Add(Down(job, Native.Key(key, 0, flags), Native.Key(key, 0, flags | 2)));
                    }
                    Pause(job, 20);
                }
                finally { for (int i = keys.Count - 1; i >= 0; i--) Release(keys[i]); }
                return new { action = request.Action, ok = true };
            }
            if (request.Action == "scroll")
            {
                string direction = request.Text("direction", 8);
                if (!new[] { "up", "down", "left", "right" }.Contains(direction)) throw new Failure("invalid_direction");
                double amount = request.Data.ContainsKey("amount") ? request.Number("amount", 1, 10) : 3;
                if (amount != Math.Floor(amount)) throw new Failure("invalid_amount");
                if (request.Data.ContainsKey("x") || request.Data.ContainsKey("y")) Move(job, Coordinates(job, "x", "y"));
                Native.POINT point;
                if (!Native.GetCursorPos(out point) || !job.Session.Display.Bounds.Contains(point.x, point.y))
                    throw new Failure("cursor_outside_display");
                uint flags = direction == "left" || direction == "right" ? 0x1000u : 0x800u;
                int delta = (direction == "down" || direction == "left" ? -120 : 120) * (int)amount;
                Inject(job, Native.Mouse(0, 0, unchecked((uint)delta), flags));
                return new { action = request.Action, ok = true };
            }
            Point start = Coordinates(job, "x", "y");
            Point end = request.Action == "drag" ? Coordinates(job, "endX", "endY") : start;
            string button = request.Text("button", 8, true) ?? "left";
            if (!new[] { "left", "right", "middle" }.Contains(button)) throw new Failure("invalid_button");
            if (!new[] { "move", "click", "doubleClick", "drag" }.Contains(request.Action)) throw new Failure("unknown_action");
            uint downFlag = button == "left" ? 2u : button == "right" ? 8u : 32u;
            uint upFlag = downFlag * 2;
            Move(job, start);
            if (request.Action == "move") return new { action = request.Action, ok = true };
            if (request.Action == "drag")
            {
                Held mouse = null;
                try
                {
                    mouse = Down(job, Native.Mouse(0, 0, 0, downFlag), Native.Mouse(0, 0, 0, upFlag));
                    for (int i = 1; i <= 30; i++)
                    {
                        Pause(job, 12);
                        Move(job, new Point(start.X + (int)Math.Round((end.X - start.X) * i / 30.0), start.Y + (int)Math.Round((end.Y - start.Y) * i / 30.0)));
                    }
                }
                finally { Release(mouse); }
                return new { action = request.Action, ok = true };
            }
            Stroke(job, Native.Mouse(0, 0, 0, downFlag), Native.Mouse(0, 0, 0, upFlag), 25);
            if (request.Action == "doubleClick")
            {
                Pause(job, (int)Math.Min(80u, Math.Max(1u, Native.GetDoubleClickTime() / 4)));
                Stroke(job, Native.Mouse(0, 0, 0, downFlag), Native.Mouse(0, 0, 0, upFlag), 25);
            }
            return new { action = request.Action, ok = true };
        }

        private Point Coordinates(Job job, string x, string y)
        {
            Rectangle bounds = job.Session.Display.Bounds;
            return new Point(bounds.Left + (int)Math.Round(job.Request.Number(x, 0, 1000) * (bounds.Width - 1) / 1000.0),
                bounds.Top + (int)Math.Round(job.Request.Number(y, 0, 1000) * (bounds.Height - 1) / 1000.0));
        }

        private void Move(Job job, Point point)
        {
            Rectangle desktop = job.Session.Display.Virtual;
            // Absolute SendInput positions span the *virtual* desktop, not the primary
            // monitor. Pixel-centre mapping handles negative origins and mixed DPI.
            int x = (int)Math.Floor((point.X - desktop.Left + 0.5) * 65536.0 / desktop.Width);
            int y = (int)Math.Floor((point.Y - desktop.Top + 0.5) * 65536.0 / desktop.Height);
            Inject(job, Native.Mouse(Math.Max(0, Math.Min(65535, x)), Math.Max(0, Math.Min(65535, y)), 0, 0xC001));
        }

        private void Inject(Job job, Native.INPUT input)
        {
            lock (inputGate)
            {
                Guard(job, true);
                if (Native.SendInput(1, new[] { input }, Marshal.SizeOf(typeof(Native.INPUT))) != 1)
                    throw new Failure("input_blocked", true);
                Interlocked.Increment(ref injections);
            }
        }

        private Held Down(Job job, Native.INPUT input, Native.INPUT up)
        {
            lock (inputGate)
            {
                Guard(job, true);
                Held token = new Held { Up = up };
                held.Add(token);
                try
                {
                    if (Native.SendInput(1, new[] { input }, Marshal.SizeOf(typeof(Native.INPUT))) != 1)
                        throw new Failure("input_blocked", true);
                    Interlocked.Increment(ref injections);
                    return token;
                }
                catch { Release(token); throw; }
            }
        }

        private void Stroke(Job job, Native.INPUT down, Native.INPUT up, int delay)
        {
            Held token = null;
            try { token = Down(job, down, up); Pause(job, delay); }
            finally { Release(token); }
        }

        private void Release(Held token)
        {
            lock (inputGate)
            {
                if (token == null || !held.Contains(token)) return;
                for (int attempt = 0; attempt < 3; attempt++)
                {
                    if (Native.SendInput(1, new[] { token.Up }, Marshal.SizeOf(typeof(Native.INPUT))) != 1) continue;
                    Interlocked.Increment(ref injections);
                    held.Remove(token);
                    return;
                }
                // Cleanup is allowed after revocation, but never a new down/move.
                RequestStop("input_release_failed", null, true);
            }
        }

        private bool ReleaseAll()
        {
            foreach (Held token in held.ToArray().Reverse()) Release(token);
            return held.Count == 0;
        }

        private void Pause(Job job, int milliseconds)
        {
            long until = Program.Clock.ElapsedMilliseconds + milliseconds;
            do
            {
                Guard(job, true);
                long remaining = until - Program.Clock.ElapsedMilliseconds;
                if (remaining <= 0) return;
                Thread.Sleep((int)Math.Min(8, remaining));
            } while (true);
        }

        internal static ushort[] ParseChord(string text)
        {
            string[] parts = text.Split('+').Select(part => part.Trim().ToUpperInvariant()).ToArray();
            if (parts.Length == 0 || parts.Length > 4 || parts.Any(part => part.Length == 0)) throw new Failure("invalid_key");
            List<ushort> keys = new List<ushort>();
            for (int i = 0; i < parts.Length - 1; i++)
            {
                ushort modifier = parts[i] == "CTRL" || parts[i] == "CONTROL" ? (ushort)0xA2 :
                    parts[i] == "SHIFT" ? (ushort)0xA0 : parts[i] == "ALT" ? (ushort)0xA4 : (ushort)0;
                if (modifier == 0 || keys.Contains(modifier)) throw new Failure("invalid_key");
                keys.Add(modifier);
            }
            string key = parts[parts.Length - 1];
            Dictionary<string, ushort> named = new Dictionary<string, ushort>
            {
                { "ENTER", 13 }, { "RETURN", 13 }, { "TAB", 9 }, { "ESC", 27 }, { "ESCAPE", 27 },
                { "SPACE", 32 }, { "BACKSPACE", 8 }, { "DELETE", 46 }, { "INSERT", 45 },
                { "HOME", 36 }, { "END", 35 }, { "PAGEUP", 33 }, { "PAGEDOWN", 34 },
                { "LEFT", 37 }, { "UP", 38 }, { "RIGHT", 39 }, { "DOWN", 40 },
                { "ARROWLEFT", 37 }, { "ARROWUP", 38 }, { "ARROWRIGHT", 39 }, { "ARROWDOWN", 40 }
            };
            ushort code;
            int function;
            if (key.Length == 1 && ((key[0] >= 'A' && key[0] <= 'Z') || (key[0] >= '0' && key[0] <= '9'))) code = key[0];
            else if (key.StartsWith("F", StringComparison.Ordinal) && Int32.TryParse(key.Substring(1), out function) && function >= 1 && function <= 12)
                code = (ushort)(111 + function);
            else if (!named.TryGetValue(key, out code)) throw new Failure("invalid_key");
            if (keys.Contains(0xA2) && keys.Contains(0xA4) && code == 46) throw new Failure("invalid_key");
            keys.Add(code);
            return keys.ToArray();
        }

        private void ThreadError(object sender, ThreadExceptionEventArgs args) { RequestStop("overlay_failed", null, true); }

        public void Dispose()
        {
            lock (stateGate) { disposed = true; state = 3; ++generation; }
            if (watchdog != null) watchdog.Dispose();
            timer.Dispose();
            jobs.CompleteAdding();
            Application.ThreadException -= ThreadError;
            if (hook != IntPtr.Zero) { Native.UnhookWindowsHookEx(hook); hook = IntPtr.Zero; }
            lock (inputGate) ReleaseAll();
            if (border != null) border.CloseSafely();
            if (halo != null) halo.CloseSafely();
            if (pill != null) pill.CloseSafely();
            if (registered) Native.WTSUnRegisterSessionNotification(ui.Handle);
            ui.Dispose();
            context.Dispose();
        }

        private void BeginSelfTest()
        {
            try
            {
                Native.RequireCapabilities(dpi);
                fixture = new Fixture(this);
                fixture.Show();
                fixture.BringToFront();
                if (!Native.SetForegroundWindow(fixture.Handle)) throw new Failure("fixture_focus_unavailable");
                fixture.RequireIdentity();
                long ticket;
                lock (stateGate) { state = 1; ticket = ++generation; }
                Start(Request.Parse("{\"id\":\"self-test-start\",\"action\":\"start\",\"labels\":{\"active\":\"Overcode native input fixture\",\"stop\":\"Stop test\",\"escape\":\"Esc\"}}"), ticket);
                jobs.Add(new Job { Session = Current(), SelfTest = true });
            }
            catch (Exception error)
            {
                exitCode = 1;
                Reject("self-test", error is Failure ? error.Message : "fixture_failed");
                EndSelfTest();
            }
        }

        private void SelfTest(Job job)
        {
            string stage = "screenshot";
            try
            {
                job.Request = Request.Parse("{\"id\":\"fixture-frame\",\"action\":\"screenshot\"}");
                object firstImage = ScreenshotEvidence(Screenshot(job));
                string frame = job.Session.Frame.Id;
                bool staleRejected = false;
                job.Request = Request.Parse("{\"id\":\"fixture-stale\",\"action\":\"press\",\"frameId\":\"wrong-frame\",\"key\":\"Enter\"}");
                try { Input(job); }
                catch (Failure error) { if (error.Message != "stale_frame") throw; staleRejected = true; }
                if (!staleRejected) throw new Failure("fixture_stale_frame_failed");
                Rectangle bounds = job.Session.Display.Bounds;
                Point text = (Point)ui.Invoke(new Func<Point>(() => fixture.Editor.PointToScreen(new Point(20, 20))));
                Point button = (Point)ui.Invoke(new Func<Point>(() => fixture.Button.PointToScreen(new Point(30, 20))));
                Point mouse = (Point)ui.Invoke(new Func<Point>(() => fixture.Surface.PointToScreen(new Point(80, 50))));
                Point dragStart = (Point)ui.Invoke(new Func<Point>(() => fixture.Surface.PointToScreen(new Point(60, 100))));
                Point dragEnd = (Point)ui.Invoke(new Func<Point>(() => fixture.Surface.PointToScreen(new Point(260, 145))));
                Action<string, Dictionary<string, object>> act = delegate(string action, Dictionary<string, object> data)
                {
                    data["frameId"] = frame;
                    job.Request = new Request { Id = "fixture-input", Action = action, Data = data };
                    Input(job);
                };
                Func<Point, Dictionary<string, object>> point = position => new Dictionary<string, object>
                {
                    { "x", (position.X - bounds.Left) * 1000.0 / (bounds.Width - 1) },
                    { "y", (position.Y - bounds.Top) * 1000.0 / (bounds.Height - 1) }
                };
                stage = "cursor_move";
                act("move", point(mouse));
                Native.POINT actual;
                if (!Native.GetCursorPos(out actual) || Math.Abs(actual.x - mouse.X) > 1 || Math.Abs(actual.y - mouse.Y) > 1)
                    throw new Failure("fixture_move_failed");
                object cursorEvidence = new { expected = new { x = mouse.X, y = mouse.Y }, actual = new { x = actual.x, y = actual.y } };
                stage = "text_click";
                act("click", point(text));
                const string sample = "Overcode Unicode \u03a9 \u4f60\u597d \ud83c\udf0d\r\nTyped newline";
                stage = "unicode_type";
                act("type", new Dictionary<string, object> { { "text", sample } });
                WaitForFixture(job, () => fixture.Editor.Text == sample, "fixture_type_failed");
                stage = "enter_key";
                act("press", new Dictionary<string, object> { { "key", "Enter" } });
                act("type", new Dictionary<string, object> { { "text", "After Enter" } });
                const string expectedText = sample + "\r\nAfter Enter";
                WaitForFixture(job, () => fixture.Editor.Text == expectedText, "fixture_enter_failed");
                stage = "control_chord";
                act("press", new Dictionary<string, object> { { "key", "Ctrl+A" } });
                WaitForFixture(job, () => fixture.Editor.SelectedText == expectedText, "fixture_chord_failed");
                stage = "button_click";
                act("click", point(button));
                WaitForFixture(job, () => fixture.Clicks == 1, "fixture_click_failed");
                stage = "double_click";
                act("doubleClick", point(mouse));
                WaitForFixture(job, () => fixture.Surface.DoubleClicks == 1, "fixture_double_click_failed");
                stage = "drag";
                Dictionary<string, object> drag = point(dragStart);
                drag["endX"] = (dragEnd.X - bounds.Left) * 1000.0 / (bounds.Width - 1);
                drag["endY"] = (dragEnd.Y - bounds.Top) * 1000.0 / (bounds.Height - 1);
                act("drag", drag);
                WaitForFixture(job, () => fixture.Surface.DragMoves >= 10 && fixture.Surface.DragDistance >= 190, "fixture_drag_failed");
                stage = "scroll";
                foreach (string direction in new[] { "down", "up", "left", "right" })
                {
                    Dictionary<string, object> scroll = point(mouse);
                    scroll["direction"] = direction;
                    scroll["amount"] = direction == "down" || direction == "left" ? 2 : 1;
                    act("scroll", scroll);
                }
                WaitForFixture(job, () => fixture.Surface.Vertical.SequenceEqual(new[] { -240, 120 }) &&
                    fixture.Surface.Horizontal.SequenceEqual(new[] { -240, 120 }), "fixture_scroll_failed");
                object mouseEvidence = ui.Invoke(new Func<object>(() => fixture.Surface.Evidence()));
                stage = "injected_escape";
                act("press", new Dictionary<string, object> { { "key", "Esc" } });
                Guard(job, true);
                if (injectedEscapes < 1) throw new Failure("fixture_injected_escape_not_observed");
                if (Interlocked.Read(ref screenshots) != 1) throw new Failure("fixture_automatic_screenshot");
                stage = "second_screenshot";
                job.Request = Request.Parse("{\"id\":\"fixture-frame-2\",\"action\":\"screenshot\"}");
                object secondImage = ScreenshotEvidence(Screenshot(job));
                job.Request = new Request { Id = "fixture-old-frame", Action = "press", Data = new Dictionary<string, object> { { "frameId", frame }, { "key", "Enter" } } };
                bool previousFrameRejected = false;
                try { Input(job); }
                catch (Failure error) { if (error.Message != "stale_frame") throw; previousFrameRejected = true; }
                if (!previousFrameRejected) throw new Failure("fixture_previous_frame_failed");
                frame = job.Session.Frame.Id;
                stage = "cancel_setup";
                act("click", point(text));
                act("press", new Dictionary<string, object> { { "key", "Ctrl+A" } });
                WaitForFixture(job, () => fixture.Editor.SelectedText == expectedText, "fixture_chord_failed");
                ui.Invoke(new Action(delegate { fixture.CancelSoon(); }));
                bool cancelled = false;
                stage = "typing_cancel";
                try { act("type", new Dictionary<string, object> { { "text", new string('x', 2000) } }); }
                catch (Failure error) { if (error.Message != "cancelled") throw; cancelled = true; }
                int length = (int)ui.Invoke(new Func<int>(() => fixture.Editor.Text.Length));
                bool released;
                lock (inputGate) released = held.Count == 0;
                if (!cancelled || length <= 0 || length >= 2000 || !released) throw new Failure("fixture_cancel_failed");
                bool generationRejected = false;
                try { Input(job); }
                catch (Failure error) { if (error.Message != "cancelled") throw; generationRejected = true; }
                if (!generationRejected) throw new Failure("fixture_generation_failed");
                long injected = Interlocked.Read(ref injections);
                Thread.Sleep(120);
                int settledLength = (int)ui.Invoke(new Func<int>(() => fixture.Editor.Text.Length));
                if (Interlocked.Read(ref injections) != injected) throw new Failure("fixture_injected_after_cancel");
                // SendInput has already queued messages in Windows. A posted UI query
                // can overtake their delivery; cancellation forbids NEW injections,
                // not the completion of a character submitted before revocation.
                Thread.Sleep(120);
                bool stable = (bool)ui.Invoke(new Func<bool>(() => fixture.Editor.Text.Length == settledLength));
                if (!stable || settledLength >= 2000 || Interlocked.Read(ref injections) != injected)
                    throw new Failure("fixture_cancel_did_not_settle");
                foreach (int key in new[] { 1, 2, 4, 0x10, 0x11, 0x12 })
                    if ((Native.GetAsyncKeyState(key) & 0x8000) != 0) throw new Failure("fixture_os_input_held");
                if (Interlocked.Read(ref screenshots) != 2) throw new Failure("fixture_automatic_screenshot");
                Reply("self-test", new
                {
                    screenshots = new[] { firstImage, secondImage }, onDemandScreenshots = screenshots, automaticScreenshots = 0,
                    cursor = cursorEvidence, mouse = mouseEvidence, clickCount = 1, unicodeTyped = true,
                    typedNewline = true, enterPressed = true, controlASelectedCharacters = expectedText.Length,
                    cancelled = cancelled, typedBeforeCancel = length, noInjectionsAfterCancel = stable,
                    charactersAfterDrain = settledLength, queuedCharactersCompleted = settledLength - length,
                    textStableAfterDrain = stable,
                    allReleased = released, injectedEscapeIgnored = true, physicalEscapeTested = false,
                    injectedEscapeHookCallbacks = injectedEscapes, successfulInputEvents = injected,
                    staleFrameRejected = staleRejected, cancelledGenerationRejected = generationRejected,
                    previousFrameRejected = previousFrameRejected,
                    focusAndIdentityGuarded = true
                });
            }
            catch (Exception error)
            {
                exitCode = 1;
                IntPtr foreground = Native.GetForegroundWindow();
                Reply("self-test-diagnostics", new
                {
                    stage = stage, fixture = fixture == null ? null : fixture.Observation(),
                    foregroundOverlay = foreground == job.Session.Border ? "border" : foreground == job.Session.Halo ? "halo" : foreground == job.Session.Pill ? "pill" : "none"
                });
                Reject("self-test", error is Failure ? error.Message : "fixture_failed");
            }
            finally { ui.BeginInvoke(new Action(EndSelfTest)); }
        }

        private void WaitForFixture(Job job, Func<bool> ready, string error)
        {
            long deadline = Program.Clock.ElapsedMilliseconds + 1000;
            do
            {
                Guard(job, true);
                if ((bool)ui.Invoke(ready)) return;
                Thread.Sleep(10);
            } while (Program.Clock.ElapsedMilliseconds < deadline);
            throw new Failure(error);
        }

        private object ScreenshotEvidence(object screenshot)
        {
            JavaScriptSerializer serializer = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 };
            Dictionary<string, object> encoded = serializer.Deserialize<Dictionary<string, object>>(serializer.Serialize(screenshot));
            Dictionary<string, object> frame = (Dictionary<string, object>)encoded["frame"];
            byte[] bytes = Convert.FromBase64String((string)frame["data"]);
            using (MemoryStream stream = new MemoryStream(bytes))
            using (Bitmap image = new Bitmap(stream))
            using (SHA256 hash = SHA256.Create())
            {
                if (image.Width > 1280 || image.Height > 720 || image.Width != (int)frame["width"] || image.Height != (int)frame["height"])
                    throw new Failure("fixture_screenshot_dimensions_failed");
                Rectangle bounds = session.Display.Bounds;
                // Only inspect the fixture's known blank background behind the pill and
                // border. Neither screenshot bytes nor pixel values leave the fixture.
                foreach (Point point in new[] { new Point(bounds.Width / 2, 30), new Point(8, bounds.Height / 2) })
                {
                    Color pixel = image.GetPixel(point.X * image.Width / bounds.Width, point.Y * image.Height / bounds.Height);
                    if (Math.Abs(pixel.R - 235) > 12 || Math.Abs(pixel.G - 239) > 12 || Math.Abs(pixel.B - 239) > 12)
                        throw new Failure("fixture_overlay_exclusion_failed");
                }
                return new { width = image.Width, height = image.Height, mime = frame["mime"], bytes = bytes.Length,
                    sha256 = BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(), overlayExcluded = true };
            }
        }

        private void EndSelfTest()
        {
            if (fixture != null)
            {
                bool restored = fixture.RestoreAndClose();
                Reply("self-test-cleanup", new { cursorRestored = restored });
                fixture = null;
            }
            RequestStop("fixture_complete", null, true);
        }
    }

    internal sealed class Dispatcher : Form
    {
        private readonly Host host;
        internal Dispatcher(Host host)
        {
            this.host = host;
            ShowInTaskbar = false;
            FormBorderStyle = FormBorderStyle.None;
        }
        protected override void WndProc(ref Message message)
        {
            if (message.Msg == 0x2B1 && (message.WParam.ToInt32() == 7 || message.WParam.ToInt32() == 6 ||
                message.WParam.ToInt32() == 2 || message.WParam.ToInt32() == 4)) host.RequestStop("session_locked", null, false);
            if (message.Msg == 0x7E || message.Msg == 0x2E0) host.RequestStop("display_changed", null, false);
            if (message.Msg == 0x11 || message.Msg == 0x16) host.RequestStop("system_shutdown", null, true);
            if (message.Msg == 0x218 && message.WParam.ToInt32() == 4) host.RequestStop("system_suspend", null, false);
            base.WndProc(ref message);
        }
    }

    internal sealed class Overlay : Form
    {
        private readonly int kind;
        private readonly string[] labels;
        private readonly Action stop;
        private readonly float scale;
        private Color accent;
        private bool closing;
        private bool hover;
        private Bitmap bitmap;

        internal Overlay(int kind, Display display, Color color, string[] labels, Action stop)
        {
            this.kind = kind;
            this.labels = labels;
            this.stop = stop;
            scale = Math.Max(1f, display.Dpi / 96f);
            accent = color;
            AutoScaleMode = AutoScaleMode.None;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            AccessibleName = String.Join(" ", labels);
            AccessibleRole = kind == 2 ? AccessibleRole.PushButton : AccessibleRole.None;
            if (kind == 0) Bounds = display.Bounds;
            if (kind == 1) Size = new Size((int)(96 * scale), (int)(96 * scale));
            if (kind == 2)
            {
                Size = PillSize(display.Bounds.Width, scale, labels);
                Location = new Point(display.Bounds.Left + (display.Bounds.Width - Width) / 2, display.Bounds.Top + (int)(16 * scale));
                Cursor = Cursors.Hand;
            }
            if (Width < 100 && kind != 1) throw new Failure("display_too_small", true);
            try
            {
                IntPtr handle = Handle;
                uint affinity;
                if (!Native.SetWindowDisplayAffinity(handle, 0x11) || !Native.GetWindowDisplayAffinity(handle, out affinity) || affinity != 0x11)
                    throw new Failure("capture_exclusion_unavailable", true);
                Draw();
            }
            catch { closing = true; Dispose(); throw; }
        }

        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams value = base.CreateParams;
                value.ExStyle |= 0x80000 | 0x8000000 | 0x80 | 0x8;
                if (kind != 2) value.ExStyle |= 0x20;
                return value;
            }
        }

        internal void Reveal()
        {
            // Bypass Form.Show's managed activation path as well as using WS_EX_NOACTIVATE.
            if (!Native.SetWindowPos(Handle, new IntPtr(-1), 0, 0, 0, 0, 0x53)) throw new Failure("overlay_unavailable", true);
        }
        internal void KeepOnTop()
        {
            if (!Native.SetWindowPos(Handle, new IntPtr(-1), 0, 0, 0, 0, 0x13)) throw new Failure("overlay_unavailable", true);
        }
        internal void Follow(Native.POINT cursor)
        {
            if (!Native.SetWindowPos(Handle, new IntPtr(-1), cursor.x - Width / 2, cursor.y - Height / 2, 0, 0, 0x11))
                throw new Failure("overlay_unavailable", true);
        }
        internal void Recolor(Color color) { accent = color; Draw(); }
        internal void CloseSafely() { closing = true; Close(); Dispose(); }
        protected override void OnFormClosed(FormClosedEventArgs args) { if (!closing) stop(); base.OnFormClosed(args); }
        protected override void OnMouseDown(MouseEventArgs args) { if (kind == 2 && args.Button == MouseButtons.Left) stop(); base.OnMouseDown(args); }
        protected override void OnMouseEnter(EventArgs args) { if (kind == 2) { hover = true; Draw(); } base.OnMouseEnter(args); }
        protected override void OnMouseLeave(EventArgs args) { if (kind == 2) { hover = false; Draw(); } base.OnMouseLeave(args); }
        protected override void WndProc(ref Message message)
        {
            if (message.Msg == 0x21) { message.Result = new IntPtr(3); return; }
            if (message.Msg == 0x84 && kind != 2) { message.Result = new IntPtr(-1); return; }
            if (message.Msg == 0x2E0 || message.Msg == 0x7E) stop();
            base.WndProc(ref message);
        }

        protected override AccessibleObject CreateAccessibilityInstance() { return new OverlayAccess(this); }
        private sealed class OverlayAccess : ControlAccessibleObject
        {
            private readonly Overlay owner;
            internal OverlayAccess(Overlay owner) : base(owner) { this.owner = owner; }
            public override string DefaultAction { get { return owner.kind == 2 ? owner.labels[1] : ""; } }
            public override void DoDefaultAction() { if (owner.kind == 2) owner.BeginInvoke(owner.stop); }
        }

        private static GraphicsPath Rounded(RectangleF rectangle, float radius)
        {
            float diameter = Math.Min(radius * 2, Math.Min(rectangle.Width, rectangle.Height));
            GraphicsPath path = new GraphicsPath();
            path.AddArc(rectangle.Left, rectangle.Top, diameter, diameter, 180, 90);
            path.AddArc(rectangle.Right - diameter, rectangle.Top, diameter, diameter, 270, 90);
            path.AddArc(rectangle.Right - diameter, rectangle.Bottom - diameter, diameter, diameter, 0, 90);
            path.AddArc(rectangle.Left, rectangle.Bottom - diameter, diameter, diameter, 90, 90);
            path.CloseFigure();
            return path;
        }

        private void Draw()
        {
            if (bitmap != null) bitmap.Dispose();
            bitmap = Render(kind, Size, scale, accent, labels, hover);
            Native.Present(Handle, bitmap, Location);
        }

        private static Size PillSize(int available, float scale, string[] labels)
        {
            using (Bitmap measure = new Bitmap(1, 1))
            using (Graphics graphics = Graphics.FromImage(measure))
            using (Font font = new Font("Segoe UI", 13 * scale, FontStyle.Regular, GraphicsUnit.Pixel))
            {
                int width = (int)Math.Ceiling(labels.Sum(label => graphics.MeasureString(label, font).Width) + 108 * scale);
                return new Size(Math.Min(width, available - (int)(40 * scale)), (int)(46 * scale));
            }
        }

        // Shared by the live layered windows and the offline preview. This function
        // paints owned memory only; it never creates a window or reads screen pixels.
        private static Bitmap Render(int kind, Size size, float scale, Color accent, string[] labels, bool hover)
        {
            Bitmap image = new Bitmap(size.Width, size.Height, PixelFormat.Format32bppPArgb);
            try
            {
                using (Graphics graphics = Graphics.FromImage(image))
                {
                    graphics.Clear(Color.Transparent);
                    graphics.SmoothingMode = SmoothingMode.AntiAlias;
                    graphics.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
                    if (kind == 0)
                    {
                        float inset = 5 * scale;
                        using (GraphicsPath path = Rounded(new RectangleF(inset, inset, size.Width - inset * 2, size.Height - inset * 2), 24 * scale))
                        {
                            graphics.SetClip(path);
                            // Clip the feathered stroke to the inside; the centre is alpha=0.
                            for (int i = 44; i >= 1; i--)
                            {
                                int alpha = 1 + (int)(9 * Math.Pow(1 - i / 45.0, 2));
                                using (Pen glow = new Pen(Color.FromArgb(alpha, accent), i * 2 * scale)) graphics.DrawPath(glow, path);
                            }
                            graphics.ResetClip();
                            using (Pen edge = new Pen(accent, 2.5f * scale)) graphics.DrawPath(edge, path);
                            using (Pen keyline = new Pen(Color.FromArgb(155, Color.White), 0.8f * scale)) graphics.DrawPath(keyline, path);
                        }
                    }
                    if (kind == 1)
                    {
                        float radius = 12 * scale;
                        RectangleF ring = new RectangleF(size.Width / 2f - radius, size.Height / 2f - radius, radius * 2, radius * 2);
                        for (int i = 22; i >= 1; i--)
                            using (Pen glow = new Pen(Color.FromArgb(2 + (int)(8 * Math.Pow(1 - i / 23.0, 2)), accent), i * scale)) graphics.DrawEllipse(glow, ring);
                        using (Pen edge = new Pen(accent, 2 * scale)) graphics.DrawEllipse(edge, ring);
                        using (Pen keyline = new Pen(Color.FromArgb(180, Color.White), 0.7f * scale)) graphics.DrawEllipse(keyline, ring);
                    }
                    if (kind == 2) DrawPill(graphics, size, scale, accent, labels, hover);
                }
                return image;
            }
            catch { image.Dispose(); throw; }
        }

        private static void DrawPill(Graphics graphics, Size size, float scale, Color accent, string[] labels, bool hover)
        {
            Color dark = Color.FromArgb(255, 12 + accent.R / 5, 12 + accent.G / 5, 12 + accent.B / 5);
            using (GraphicsPath path = Rounded(new RectangleF(1, 1, size.Width - 2, size.Height - 2), size.Height / 2f - 1))
            using (Brush fill = new SolidBrush(dark))
            using (Pen keyline = new Pen(Color.White, scale))
            using (Font font = new Font("Segoe UI", 13 * scale, FontStyle.Regular, GraphicsUnit.Pixel))
            using (Font bold = new Font("Segoe UI", 13 * scale, FontStyle.Bold, GraphicsUnit.Pixel))
            using (Brush ink = new SolidBrush(Color.White))
            using (StringFormat format = new StringFormat { LineAlignment = StringAlignment.Center, Trimming = StringTrimming.EllipsisCharacter, FormatFlags = StringFormatFlags.NoWrap })
            {
                graphics.FillPath(fill, path);
                graphics.DrawPath(keyline, path);
                float stopWidth = Math.Min(size.Width * 0.30f, graphics.MeasureString(labels[1], bold).Width + 24 * scale);
                float escapeWidth = Math.Min(size.Width * 0.25f, graphics.MeasureString(labels[2], font).Width + 18 * scale);
                float right = size.Width - stopWidth - escapeWidth - 12 * scale;
                using (Brush dot = new SolidBrush(accent)) graphics.FillEllipse(dot, 17 * scale, size.Height / 2f - 4 * scale, 8 * scale, 8 * scale);
                graphics.DrawString(labels[0], font, ink, new RectangleF(34 * scale, 0, Math.Max(1, right - 44 * scale), size.Height), format);
                if (hover)
                    using (Brush highlight = new SolidBrush(Color.FromArgb(35, Color.White)))
                    using (GraphicsPath button = Rounded(new RectangleF(right, 6 * scale, stopWidth, size.Height - 12 * scale), 10 * scale)) graphics.FillPath(highlight, button);
                using (Pen divider = new Pen(Color.FromArgb(110, Color.White), scale)) graphics.DrawLine(divider, right - 3 * scale, 13 * scale, right - 3 * scale, size.Height - 13 * scale);
                graphics.DrawString(labels[1], bold, ink, new RectangleF(right + 8 * scale, 0, stopWidth - 8 * scale, size.Height), format);
                graphics.DrawString(labels[2], font, ink, new RectangleF(right + stopWidth + 4 * scale, 0, escapeWidth, size.Height), format);
            }
        }

        internal static object Preview(string path, Color accent)
        {
            path = Path.GetFullPath(path);
            if (!String.Equals(Path.GetExtension(path), ".png", StringComparison.OrdinalIgnoreCase) || !Directory.Exists(Path.GetDirectoryName(path)))
                throw new Failure("invalid_preview_path");
            Size size = new Size(1280, 720);
            string[] labels = new[] { "Overcode is using your computer", "Stop", "Esc" };
            using (Bitmap scene = new Bitmap(size.Width, size.Height, PixelFormat.Format32bppPArgb))
            using (Bitmap border = Render(0, size, 1, accent, labels, false))
            using (Bitmap halo = Render(1, new Size(96, 96), 1, accent, labels, false))
            using (Bitmap pill = Render(2, PillSize(size.Width, 1, labels), 1, accent, labels, false))
            {
                using (Graphics graphics = Graphics.FromImage(scene))
                using (Font font = new Font("Segoe UI", 13, FontStyle.Regular, GraphicsUnit.Pixel))
                using (Pen outline = new Pen(Color.FromArgb(80, 120, 115)))
                {
                    graphics.Clear(Color.FromArgb(235, 239, 239));
                    graphics.SmoothingMode = SmoothingMode.AntiAlias;
                    graphics.DrawString("Generated fixture preview. No desktop capture.", font, Brushes.Black, 60, 78);
                    graphics.FillRectangle(Brushes.White, 60, 110, 600, 80);
                    graphics.DrawRectangle(outline, 60, 110, 600, 80);
                    graphics.DrawString("Overcode native Unicode / Enter fixture\r\nOnly generated content is visible in this preview.", font, Brushes.Black, 74, 126);
                    graphics.FillRectangle(Brushes.White, 60, 230, 240, 60);
                    graphics.DrawRectangle(outline, 60, 230, 240, 60);
                    graphics.DrawString("Fixture click target", font, Brushes.Black, 128, 252);
                    graphics.FillRectangle(Brushes.White, 60, 340, 600, 200);
                    graphics.DrawRectangle(outline, 60, 340, 600, 200);
                    graphics.DrawString("Fixture-only mouse surface: move, double-click, drag, wheel", font, Brushes.Black, 74, 354);
                    graphics.DrawImageUnscaled(border, Point.Empty);
                    graphics.DrawImageUnscaled(halo, new Point(372, 392));
                    graphics.DrawImageUnscaled(pill, new Point((size.Width - pill.Width) / 2, 16));
                    Point[] cursor = new[] { new Point(420, 440), new Point(420, 462), new Point(426, 456), new Point(431, 467), new Point(435, 465), new Point(430, 454), new Point(439, 454) };
                    graphics.FillPolygon(Brushes.Black, cursor);
                    graphics.DrawPolygon(Pens.White, cursor);
                }
                using (FileStream file = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None)) scene.Save(file, ImageFormat.Png);
                return new { path = path, width = size.Width, height = size.Height, generatedFixture = true,
                    sharedOverlayRenderer = true, borderCenterAlpha = border.GetPixel(size.Width / 2, size.Height / 2).A,
                    windowCreated = false, overlayShown = false, hookInstalled = false, inputInjected = false, screenshotTaken = false };
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing && bitmap != null) { bitmap.Dispose(); bitmap = null; }
            base.Dispose(disposing);
        }
    }

    // Explicitly opt-in, disposable foreground fixture. Never entered by --check.
    // Identity and focus are revalidated at EVERY input injection, including typing.
    internal sealed class Fixture : Form
    {
        private const string Identity = "Overcode.ComputerUse.Fixture";
        private readonly Host host;
        private readonly IntPtr nonce = new IntPtr(new Random().Next(1, Int32.MaxValue));
        private readonly Native.POINT cursor;
        private readonly Rectangle bounds;
        private readonly IntPtr window;
        private readonly uint process;
        private readonly System.Windows.Forms.Timer cancel = new System.Windows.Forms.Timer { Interval = 100 };
        private bool closing;
        internal readonly TextBox Editor = new TextBox { Location = new Point(60, 100), Size = new Size(600, 80), Multiline = true, AcceptsReturn = true };
        internal readonly Button Button = new Button { Location = new Point(60, 220), Size = new Size(240, 60), Text = "Fixture click target" };
        internal readonly FixtureSurface Surface = new FixtureSurface { Location = new Point(60, 340), Size = new Size(600, 200) };
        internal int Clicks;

        internal Fixture(Host host)
        {
            this.host = host;
            if (!Native.GetCursorPos(out cursor)) throw new Failure("fixture_cursor_unavailable");
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            AutoScaleMode = AutoScaleMode.None;
            TopMost = true;
            bounds = Native.GetDisplay(Native.MonitorFromPoint(cursor, 2)).Bounds;
            if (bounds.Width < 800 || bounds.Height < 600) throw new Failure("fixture_display_too_small");
            Bounds = bounds;
            BackColor = Color.FromArgb(235, 239, 239);
            Text = "Overcode disposable native input fixture";
            Controls.Add(Editor);
            Controls.Add(Button);
            Controls.Add(Surface);
            Controls.Add(new Label { Text = Text, Location = new Point(60, 70), AutoSize = true });
            Button.Click += delegate { Clicks++; };
            cancel.Tick += delegate { cancel.Stop(); host.RequestStop("fixture_cancel", null, false); };
            window = Handle;
            Native.GetWindowThreadProcessId(window, out process);
            if (!Native.SetProp(window, Identity, nonce))
            {
                closing = true;
                cancel.Dispose();
                Dispose();
                throw new Failure("fixture_identity_unavailable");
            }
        }

        internal void RequireIdentity()
        {
            uint current;
            Native.RECT rectangle;
            Native.GetWindowThreadProcessId(window, out current);
            if (!Native.IsWindow(window) || !Native.IsWindowVisible(window) || Native.IsIconic(window) ||
                Native.GetForegroundWindow() != window || current != process || Native.GetProp(window, Identity) != nonce ||
                !Native.GetWindowRect(window, out rectangle) || rectangle.Rectangle != bounds)
                throw new Failure("fixture_focus_lost", true);
            // A nonactivating third-party window must not cover any fixture pixels or
            // receive a mouse event while this opt-in test is running.
            for (IntPtr above = Native.GetWindow(window, 3); above != IntPtr.Zero; above = Native.GetWindow(above, 3))
            {
                uint owner;
                Native.GetWindowThreadProcessId(above, out owner);
                if (owner == process || !Native.IsWindowVisible(above)) continue;
                int cloaked;
                if (Native.DwmGetWindowAttribute(above, 14, out cloaked, 4) == 0 && cloaked != 0) continue;
                Native.RECT area;
                if (Native.GetWindowRect(above, out area) && area.Rectangle.IntersectsWith(bounds))
                    throw new Failure("fixture_occluded", true);
            }
        }
        internal object Observation()
        {
            Native.RECT rectangle;
            Native.GetWindowRect(window, out rectangle);
            return new
            {
                foregroundMatches = Native.GetForegroundWindow() == window,
                visible = Native.IsWindowVisible(window), minimized = Native.IsIconic(window),
                identityMatches = Native.GetProp(window, Identity) == nonce,
                boundsMatch = rectangle.Rectangle == bounds,
                bounds = new { x = rectangle.left, y = rectangle.top, width = rectangle.right - rectangle.left, height = rectangle.bottom - rectangle.top }
            };
        }
        internal void CancelSoon() { RequireIdentity(); cancel.Start(); }
        internal bool RestoreAndClose()
        {
            bool restored = false;
            try
            {
                RequireIdentity();
                restored = Native.SetCursorPos(cursor.x, cursor.y);
            }
            catch (Failure) { }
            closing = true;
            cancel.Dispose();
            Native.RemoveProp(window, Identity);
            Close();
            Dispose();
            return restored;
        }
        protected override void OnFormClosed(FormClosedEventArgs args)
        {
            if (!closing) host.RequestStop("fixture_closed", null, true);
            base.OnFormClosed(args);
        }
    }

    internal sealed class FixtureSurface : Control
    {
        internal int Downs, Ups, DoubleClicks, Moves, DragMoves;
        internal double DragDistance;
        internal readonly List<int> Vertical = new List<int>();
        internal readonly List<int> Horizontal = new List<int>();
        private Point down;
        internal FixtureSurface()
        {
            SetStyle(ControlStyles.StandardClick | ControlStyles.StandardDoubleClick | ControlStyles.Selectable, true);
            BackColor = Color.White;
            TabStop = true;
        }
        protected override void OnMouseDown(MouseEventArgs args)
        {
            Focus(); Downs++; down = args.Location;
            base.OnMouseDown(args);
        }
        protected override void OnMouseUp(MouseEventArgs args)
        {
            Ups++;
            DragDistance = Math.Sqrt(Math.Pow(args.X - down.X, 2) + Math.Pow(args.Y - down.Y, 2));
            base.OnMouseUp(args);
        }
        protected override void OnMouseMove(MouseEventArgs args)
        {
            Moves++;
            if ((args.Button & MouseButtons.Left) != 0) DragMoves++;
            base.OnMouseMove(args);
        }
        protected override void OnMouseDoubleClick(MouseEventArgs args) { DoubleClicks++; base.OnMouseDoubleClick(args); }
        protected override void OnMouseWheel(MouseEventArgs args) { Vertical.Add(args.Delta); base.OnMouseWheel(args); }
        protected override void WndProc(ref Message message)
        {
            if (message.Msg == 0x20E) Horizontal.Add(unchecked((short)(message.WParam.ToInt64() >> 16)));
            base.WndProc(ref message);
        }
        protected override void OnPaint(PaintEventArgs args)
        {
            base.OnPaint(args);
            using (Pen border = new Pen(Color.FromArgb(80, 120, 115))) args.Graphics.DrawRectangle(border, 0, 0, Width - 1, Height - 1);
            args.Graphics.DrawString("Fixture-only mouse surface: move, double-click, drag, wheel", Font, Brushes.Black, 12, 12);
        }
        internal object Evidence()
        {
            return new { downs = Downs, ups = Ups, doubleClicks = DoubleClicks, moves = Moves, dragMoves = DragMoves,
                dragDistance = Math.Round(DragDistance, 2), verticalWheelDeltas = Vertical.ToArray(), horizontalWheelDeltas = Horizontal.ToArray() };
        }
    }

    internal static class Native
    {
        [StructLayout(LayoutKind.Sequential)] internal struct POINT { internal int x, y; }
        [StructLayout(LayoutKind.Sequential)] internal struct SIZE { internal int cx, cy; }
        [StructLayout(LayoutKind.Sequential)] internal struct RECT
        {
            internal int left, top, right, bottom;
            internal Rectangle Rectangle { get { return Rectangle.FromLTRB(left, top, right, bottom); } }
        }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct MONITORINFO
        {
            internal int cbSize;
            internal RECT monitor, work;
            internal uint flags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] internal string device;
        }
        [StructLayout(LayoutKind.Sequential, Pack = 1)] internal struct BLENDFUNCTION { internal byte operation, flags, alpha, format; }
        [StructLayout(LayoutKind.Sequential)] internal struct MOUSEINPUT { internal int dx, dy; internal uint data, flags, time; internal UIntPtr extra; }
        [StructLayout(LayoutKind.Sequential)] internal struct KEYBDINPUT { internal ushort vk, scan; internal uint flags, time; internal UIntPtr extra; }
        [StructLayout(LayoutKind.Explicit)] internal struct INPUTUNION
        {
            [FieldOffset(0)] internal MOUSEINPUT mouse;
            [FieldOffset(0)] internal KEYBDINPUT key;
        }
        [StructLayout(LayoutKind.Sequential)] internal struct INPUT { internal uint type; internal INPUTUNION data; }
        [StructLayout(LayoutKind.Sequential)] internal struct KBDLLHOOKSTRUCT { internal uint vkCode, scanCode, flags, time; internal UIntPtr extra; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct VERSION
        {
            internal int size, major, minor, build, platform;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] internal string servicePack;
        }
        internal delegate IntPtr HookProc(int code, IntPtr message, IntPtr data);
        private delegate bool MonitorProc(IntPtr monitor, IntPtr dc, ref RECT bounds, IntPtr data);

        [DllImport("user32.dll", SetLastError = true)] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] private static extern IntPtr GetThreadDpiAwarenessContext();
        [DllImport("user32.dll")] private static extern bool AreDpiAwarenessContextsEqual(IntPtr first, IntPtr second);
        [DllImport("ntdll.dll", CharSet = CharSet.Unicode)] private static extern int RtlGetVersion(ref VERSION version);
        [DllImport("dwmapi.dll")] private static extern int DwmIsCompositionEnabled(out bool enabled);
        [DllImport("dwmapi.dll")] internal static extern int DwmFlush();
        [DllImport("dwmapi.dll")] internal static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);
        [DllImport("user32.dll", SetLastError = true)] internal static extern bool GetCursorPos(out POINT point);
        [DllImport("user32.dll", SetLastError = true)] internal static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] internal static extern IntPtr MonitorFromPoint(POINT point, uint flags);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
        [DllImport("user32.dll", SetLastError = true)] private static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorProc callback, IntPtr data);
        [DllImport("shcore.dll")] private static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint x, out uint y);
        [DllImport("user32.dll")] private static extern int GetSystemMetrics(int metric);
        [DllImport("user32.dll", SetLastError = true)] internal static extern uint SendInput(uint count, INPUT[] inputs, int size);
        [DllImport("user32.dll")] internal static extern short GetAsyncKeyState(int key);
        [DllImport("user32.dll")] internal static extern uint GetDoubleClickTime();
        [DllImport("user32.dll", SetLastError = true)] internal static extern IntPtr SetWindowsHookEx(int type, HookProc callback, IntPtr module, uint thread);
        [DllImport("user32.dll", SetLastError = true)] internal static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")] internal static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] internal static extern IntPtr GetModuleHandle(string name);
        [DllImport("user32.dll", SetLastError = true)] internal static extern bool SetWindowDisplayAffinity(IntPtr window, uint affinity);
        [DllImport("user32.dll", SetLastError = true)] internal static extern bool GetWindowDisplayAffinity(IntPtr window, out uint affinity);
        [DllImport("user32.dll")] internal static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] internal static extern bool IsWindow(IntPtr window);
        [DllImport("user32.dll")] internal static extern bool IsIconic(IntPtr window);
        [DllImport("user32.dll")] internal static extern bool GetWindowRect(IntPtr window, out RECT rectangle);
        [DllImport("user32.dll")] internal static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] internal static extern IntPtr GetWindow(IntPtr window, uint command);
        [DllImport("user32.dll")] internal static extern bool SetForegroundWindow(IntPtr window);
        [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern bool SetProp(IntPtr window, string name, IntPtr value);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern IntPtr GetProp(IntPtr window, string name);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern IntPtr RemoveProp(IntPtr window, string name);
        [DllImport("user32.dll", SetLastError = true)] internal static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
        [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr window);
        [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr window, IntPtr dc);
        [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleDC(IntPtr dc);
        [DllImport("gdi32.dll")] private static extern bool DeleteDC(IntPtr dc);
        [DllImport("gdi32.dll")] private static extern IntPtr SelectObject(IntPtr dc, IntPtr value);
        [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr value);
        [DllImport("user32.dll", SetLastError = true)] private static extern bool UpdateLayeredWindow(IntPtr window, IntPtr destination, ref POINT position, ref SIZE size, IntPtr source, ref POINT origin, uint key, ref BLENDFUNCTION blend, uint flags);
        [DllImport("wtsapi32.dll", SetLastError = true)] internal static extern bool WTSRegisterSessionNotification(IntPtr window, uint flags);
        [DllImport("wtsapi32.dll")] internal static extern bool WTSUnRegisterSessionNotification(IntPtr window);
        [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool WTSQuerySessionInformation(IntPtr server, int session, int kind, out IntPtr buffer, out int bytes);
        [DllImport("wtsapi32.dll")] private static extern void WTSFreeMemory(IntPtr buffer);
        [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool GetUserObjectInformation(IntPtr handle, int kind, StringBuilder value, int length, out int needed);

        internal static bool EnableDpi()
        {
            try
            {
                return SetProcessDpiAwarenessContext(new IntPtr(-4)) ||
                    AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), new IntPtr(-4));
            }
            catch (EntryPointNotFoundException) { return false; }
        }

        internal static object Check(bool dpi)
        {
            VERSION version = new VERSION { size = Marshal.SizeOf(typeof(VERSION)) };
            if (RtlGetVersion(ref version) != 0) throw new Failure("windows_version_unavailable");
            bool composition;
            bool composed = DwmIsCompositionEnabled(out composition) == 0 && composition;
            bool interactive = InteractiveDesktop();
            bool supported = version.major >= 10 && version.build >= 19041 && dpi && composed && interactive;
            return new
            {
                supported = supported, windowsBuild = version.build, framework = Environment.Version.ToString(),
                pointerBits = IntPtr.Size * 8, inputStructureBytes = Marshal.SizeOf(typeof(INPUT)),
                perMonitorV2 = dpi, desktopComposition = composed, localInteractiveDesktop = interactive,
                captureExclusionSupported = version.major >= 10 && version.build >= 19041,
                hookInstalled = false, overlayShown = false, inputInjected = false, screenshotTaken = false,
                requiresActivationProbe = true, leaseMs = 600000, idleTimeoutMs = 120000, frameMaxAgeMs = 120000,
                maxScreenshot = new { width = 1280, height = 720 }, maxTextLength = 2000, maxScrollAmount = 10,
                protocol = "json-lines-v1"
            };
        }

        internal static void RequireCapabilities(bool dpi)
        {
            VERSION version = new VERSION { size = Marshal.SizeOf(typeof(VERSION)) };
            if (RtlGetVersion(ref version) != 0 || version.major < 10 || version.build < 19041)
                throw new Failure("windows_version_unsupported");
            bool composition;
            if (!dpi) throw new Failure("dpi_awareness_unavailable");
            if (DwmIsCompositionEnabled(out composition) != 0 || !composition) throw new Failure("desktop_composition_unavailable");
            if (!InteractiveDesktop()) throw new Failure("desktop_unavailable");
        }

        internal static bool InteractiveDesktop()
        {
            if (!Environment.UserInteractive || GetSystemMetrics(0x1000) != 0) return false;
            IntPtr buffer;
            int bytes;
            if (!WTSQuerySessionInformation(IntPtr.Zero, -1, 8, out buffer, out bytes)) return false;
            try { if (bytes < 4 || Marshal.ReadInt32(buffer) != 0) return false; }
            finally { WTSFreeMemory(buffer); }
            if (!WTSQuerySessionInformation(IntPtr.Zero, -1, 16, out buffer, out bytes)) return false;
            try { if (bytes < 2 || Marshal.ReadInt16(buffer) != 0) return false; }
            finally { WTSFreeMemory(buffer); }
            IntPtr desktop = OpenInputDesktop(0, false, 1);
            if (desktop == IntPtr.Zero) return false;
            try
            {
                StringBuilder name = new StringBuilder(256);
                int needed;
                return GetUserObjectInformation(desktop, 2, name, name.Capacity * 2, out needed) && name.ToString() == "Default";
            }
            finally { CloseDesktop(desktop); }
        }

        internal static Display GetDisplay(IntPtr selected)
        {
            List<string> layout = new List<string>();
            Display display = null;
            bool failed = false;
            MonitorProc callback = delegate(IntPtr monitor, IntPtr dc, ref RECT bounds, IntPtr data)
            {
                MONITORINFO info = new MONITORINFO { cbSize = Marshal.SizeOf(typeof(MONITORINFO)) };
                uint x, y;
                if (!GetMonitorInfo(monitor, ref info) || GetDpiForMonitor(monitor, 0, out x, out y) != 0)
                { failed = true; return false; }
                layout.Add(info.device + ":" + info.monitor.Rectangle.ToString() + ":" + info.work.Rectangle.ToString() + ":" + x + ":" + y + ":" + info.flags);
                if (monitor == selected) display = new Display { Monitor = monitor, Bounds = info.monitor.Rectangle, Dpi = x };
                return true;
            };
            if (!EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero) || failed || display == null)
                throw new Failure("display_unavailable", true);
            display.Virtual = new Rectangle(GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(78), GetSystemMetrics(79));
            if (display.Bounds.Width <= 0 || display.Bounds.Height <= 0 || (long)display.Bounds.Width * display.Bounds.Height > 64000000 ||
                display.Virtual.Width <= 0 || display.Virtual.Height <= 0) throw new Failure("display_unsupported", true);
            layout.Sort(StringComparer.Ordinal);
            display.Signature = String.Join("|", layout) + "|" + display.Virtual.ToString();
            return display;
        }

        internal static INPUT Mouse(int x, int y, uint data, uint flags)
        {
            return new INPUT { type = 0, data = new INPUTUNION { mouse = new MOUSEINPUT { dx = x, dy = y, data = data, flags = flags, extra = new UIntPtr(0x4F434355) } } };
        }
        internal static INPUT Key(ushort vk, ushort scan, uint flags)
        {
            return new INPUT { type = 1, data = new INPUTUNION { key = new KEYBDINPUT { vk = vk, scan = scan, flags = flags, extra = new UIntPtr(0x4F434355) } } };
        }

        internal static void Present(IntPtr window, Bitmap bitmap, Point location)
        {
            IntPtr screen = GetDC(IntPtr.Zero);
            if (screen == IntPtr.Zero) throw new Failure("overlay_unavailable", true);
            IntPtr memory = IntPtr.Zero, image = IntPtr.Zero, old = IntPtr.Zero;
            try
            {
                memory = CreateCompatibleDC(screen);
                image = bitmap.GetHbitmap(Color.FromArgb(0));
                if (memory == IntPtr.Zero || image == IntPtr.Zero) throw new Failure("overlay_unavailable", true);
                old = SelectObject(memory, image);
                if (old == IntPtr.Zero || old == new IntPtr(-1)) throw new Failure("overlay_unavailable", true);
                POINT position = new POINT { x = location.X, y = location.Y };
                POINT origin = new POINT();
                SIZE size = new SIZE { cx = bitmap.Width, cy = bitmap.Height };
                BLENDFUNCTION blend = new BLENDFUNCTION { alpha = 255, format = 1 };
                if (!UpdateLayeredWindow(window, screen, ref position, ref size, memory, ref origin, 0, ref blend, 2))
                    throw new Failure("overlay_unavailable", true);
            }
            finally
            {
                if (old != IntPtr.Zero && old != new IntPtr(-1)) SelectObject(memory, old);
                if (image != IntPtr.Zero) DeleteObject(image);
                if (memory != IntPtr.Zero) DeleteDC(memory);
                ReleaseDC(IntPtr.Zero, screen);
            }
        }
    }
}
