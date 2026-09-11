import { execFile, spawn } from "node:child_process"
import { Buffer } from "node:buffer"
import { createInterface } from "node:readline"
import { promisify } from "node:util"

export type WindowsSpeechSession = {
  stop: () => void
}

type WindowsSpeechSessionOptions = {
  language?: string
  onResult: (text: string) => void
  onInterim: (text: string) => void
  onLevel: (level: number) => void
  onError: (message: string) => void
  onEnd: () => void
}

const windowsSpeechScript = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech

# System.Speech raises callbacks on worker threads. PowerShell script-block
# delegates require a runspace and crash as soon as the first audio event is
# delivered, so keep the event handlers inside .NET code.
$bridgeSource = @'
using System;
using System.Globalization;
using System.Speech.Recognition;
using System.Text;
using System.Threading;

public sealed class OpenCodeSpeechBridge : IDisposable
{
    private readonly SpeechRecognitionEngine engine;
    private readonly object outputGate = new object();
    private readonly ManualResetEvent completed = new ManualResetEvent(false);
    private bool stopping;

    public OpenCodeSpeechBridge(string culture)
    {
        engine = new SpeechRecognitionEngine(CultureInfo.GetCultureInfo(culture));
        engine.SetInputToDefaultAudioDevice();
        engine.LoadGrammar(new DictationGrammar());
        engine.SpeechRecognized += OnSpeechRecognized;
        engine.SpeechHypothesized += OnSpeechHypothesized;
        engine.AudioLevelUpdated += OnAudioLevelUpdated;
        engine.RecognizeCompleted += OnRecognizeCompleted;
        engine.InitialSilenceTimeout = TimeSpan.FromSeconds(10);
        engine.BabbleTimeout = TimeSpan.FromSeconds(0.3);
        engine.EndSilenceTimeout = TimeSpan.FromSeconds(0.55);
        engine.EndSilenceTimeoutAmbiguous = TimeSpan.FromSeconds(0.85);
    }

    public void Start()
    {
        engine.RecognizeAsync(RecognizeMode.Multiple);
    }

    public void Stop()
    {
        if (stopping) return;
        stopping = true;
        try {
            engine.RecognizeAsyncCancel();
        } catch (InvalidOperationException) {
        }
    }

    public bool WaitForCompletion(int milliseconds)
    {
        return completed.WaitOne(milliseconds);
    }

    private void OnSpeechRecognized(object sender, SpeechRecognizedEventArgs eventArgs)
    {
        string text = eventArgs.Result.Text;
        if (String.IsNullOrWhiteSpace(text)) return;
        Write("{\"type\":\"result\",\"text\":\"" + Escape(text) + "\"}");
    }

    private void OnSpeechHypothesized(object sender, SpeechHypothesizedEventArgs eventArgs)
    {
        string text = eventArgs.Result.Text;
        if (String.IsNullOrWhiteSpace(text)) return;
        Write("{\"type\":\"interim\",\"text\":\"" + Escape(text) + "\"}");
    }

    private void OnAudioLevelUpdated(object sender, AudioLevelUpdatedEventArgs eventArgs)
    {
        Write("{\"type\":\"level\",\"level\":" + eventArgs.AudioLevel + "}");
    }

    private void OnRecognizeCompleted(object sender, RecognizeCompletedEventArgs eventArgs)
    {
        if (eventArgs.Error != null) {
            Write("{\"type\":\"error\",\"message\":\"" + Escape(eventArgs.Error.Message) + "\"}");
        }
        Write("{\"type\":\"end\"}");
        completed.Set();
    }

    private void Write(string value)
    {
        lock (outputGate) {
            Console.Out.WriteLine(value);
            Console.Out.Flush();
        }
    }

    private static string Escape(string value)
    {
        StringBuilder output = new StringBuilder(value.Length + 8);
        foreach (char character in value) {
            switch (character) {
                case '\\': output.Append("\\\\"); break;
                case '"': output.Append("\\\""); break;
                case '\b': output.Append("\\b"); break;
                case '\f': output.Append("\\f"); break;
                case '\n': output.Append("\\n"); break;
                case '\r': output.Append("\\r"); break;
                case '\t': output.Append("\\t"); break;
                default:
                    if (character < 32) output.Append("\\u" + ((int)character).ToString("x4"));
                    else output.Append(character);
                    break;
            }
        }
        return output.ToString();
    }

    public void Dispose()
    {
        engine.SpeechRecognized -= OnSpeechRecognized;
        engine.SpeechHypothesized -= OnSpeechHypothesized;
        engine.AudioLevelUpdated -= OnAudioLevelUpdated;
        engine.RecognizeCompleted -= OnRecognizeCompleted;
        engine.Dispose();
        completed.Dispose();
    }
}
'@
Add-Type -TypeDefinition $bridgeSource -ReferencedAssemblies System.Speech

$requestedLanguage = $env:OPENCODE_SPEECH_LANGUAGE
$requestedCulture = $null
try {
  if ($requestedLanguage) {
    $requestedCulture = [System.Globalization.CultureInfo]::GetCultureInfo($requestedLanguage)
  }
} catch {
  $requestedCulture = $null
}

$recognizerInfo = $null
$recognizers = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
if ($requestedCulture) {
  $recognizerInfo = $recognizers | Where-Object { $_.Culture.Name -eq $requestedCulture.Name } | Select-Object -First 1
  if (-not $recognizerInfo) {
    $recognizerInfo = $recognizers | Where-Object { $_.Culture.TwoLetterISOLanguageName -eq $requestedCulture.TwoLetterISOLanguageName } | Select-Object -First 1
  }
}
if (-not $recognizerInfo) {
  $recognizerInfo = $recognizers | Select-Object -First 1
}
if (-not $recognizerInfo) {
  throw "No Windows speech recognizer is installed."
}

$bridge = New-Object OpenCodeSpeechBridge($recognizerInfo.Culture.Name)
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $bridge.Start()
  $readTask = [Console]::In.ReadLineAsync()
  while (-not $bridge.WaitForCompletion(50)) {
    if (-not $readTask.IsCompleted) { continue }
    $line = $readTask.Result
    if ($line -eq "stop" -or $null -eq $line) {
      $bridge.Stop()
      [void]$bridge.WaitForCompletion(1000)
      break
    }
    $readTask = [Console]::In.ReadLineAsync()
  }
} finally {
  $bridge.Dispose()
}
`

const encodedSpeechScript = Buffer.from(windowsSpeechScript, "utf16le").toString("base64")

const execFileAsync = promisify(execFile)
let recognizerCheck: Promise<boolean> | undefined

export function isWindowsSpeechAvailable() {
  if (process.platform !== "win32") return Promise.resolve(false)
  if (recognizerCheck) return recognizerCheck

  recognizerCheck = execFileAsync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "Add-Type -AssemblyName System.Speech; [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers().Count -gt 0",
    ],
    { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 },
  )
    .then(({ stdout }) => stdout.trim().toLowerCase() === "true")
    .catch(() => false)

  return recognizerCheck
}

export function startWindowsSpeech(options: WindowsSpeechSessionOptions): WindowsSpeechSession {
  if (process.platform !== "win32") throw new Error("Windows dictation is unavailable on this platform.")

  const child = spawn(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedSpeechScript],
    {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, OPENCODE_SPEECH_LANGUAGE: options.language ?? "en-US" },
    },
  )

  let stopped = false
  let ended = false
  let stderr = ""
  const finish = () => {
    if (ended) return
    ended = true
    options.onEnd()
  }
  const fail = (message: string) => {
    if (stopped || ended) return
    options.onError(message)
  }

  const lines = createInterface({ input: child.stdout })
  lines.on("line", (line) => {
    try {
      const event = JSON.parse(line) as { type?: string; text?: string; message?: string }
      if (event.type === "result" && event.text) options.onResult(event.text)
      if (event.type === "interim" && event.text) options.onInterim(event.text)
      if (event.type === "level" && typeof (event as { level?: unknown }).level === "number") {
        options.onLevel((event as { level: number }).level)
      }
      if (event.type === "error" && event.message) options.onError(event.message)
      if (event.type === "end") finish()
    } catch {
      // PowerShell should only emit JSON on stdout. Ignore unexpected startup noise.
    }
  })
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString()
  })
  child.on("error", (error) => fail(error.message))
  child.on("close", (code) => {
    lines.close()
    if (!stopped && code !== 0) fail(stderr.trim() || "Windows dictation stopped unexpectedly.")
    finish()
  })

  return {
    stop: () => {
      if (stopped) return
      stopped = true
      if (!child.stdin.destroyed) child.stdin.write("stop\n")
      const timer = setTimeout(() => child.kill(), 1000)
      timer.unref()
    },
  }
}
