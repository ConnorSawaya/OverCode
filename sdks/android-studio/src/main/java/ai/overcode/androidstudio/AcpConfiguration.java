package ai.overcode.androidstudio;

import java.nio.file.Path;
import java.util.Objects;

public final class AcpConfiguration {
    private AcpConfiguration() {}

    public static Path path(Path userHome) {
        return Objects.requireNonNull(userHome, "userHome").resolve(".jetbrains").resolve("acp.json");
    }

    public static String render(String command) {
        Objects.requireNonNull(command, "command");
        return "{\n"
                + "  \"agent_servers\": {\n"
                + "    \"Overcode\": {\n"
                + "      \"command\": \"" + escapeJson(command) + "\",\n"
                + "      \"args\": [\"acp\"]\n"
                + "    }\n"
                + "  }\n"
                + "}\n";
    }

    public static boolean containsOvercodeAgent(String content) {
        return content != null && content.contains("\"Overcode\"");
    }

    private static String escapeJson(String value) {
        StringBuilder escaped = new StringBuilder(value.length());
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            switch (character) {
                case '\\' -> escaped.append("\\\\");
                case '"' -> escaped.append("\\\"");
                case '\n' -> escaped.append("\\n");
                case '\r' -> escaped.append("\\r");
                case '\t' -> escaped.append("\\t");
                default -> escaped.append(character);
            }
        }
        return escaped.toString();
    }
}
