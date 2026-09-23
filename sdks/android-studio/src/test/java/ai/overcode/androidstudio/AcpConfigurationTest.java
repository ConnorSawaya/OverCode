package ai.overcode.androidstudio;

import org.junit.jupiter.api.Test;

import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

final class AcpConfigurationTest {
    @Test
    void rendersJetBrainsAgentConfiguration() {
        assertEquals(
                "{\n"
                        + "  \"agent_servers\": {\n"
                        + "    \"Overcode\": {\n"
                        + "      \"command\": \"overcode\",\n"
                        + "      \"args\": [\"acp\"]\n"
                        + "    }\n"
                        + "  }\n"
                        + "}\n",
                AcpConfiguration.render("overcode")
        );
    }

    @Test
    void escapesCommandsAndPreservesExistingConfiguration() {
        assertTrue(AcpConfiguration.render("C:\\Tools\\Overcode\\overcode.exe").contains("C:\\\\Tools"));
        assertTrue(AcpConfiguration.containsOvercodeAgent("{\"agent_servers\":{\"Overcode\":{}}}"));
        assertFalse(AcpConfiguration.containsOvercodeAgent("{\"agent_servers\":{}}"));
        assertEquals(
                Path.of("C:/Users/example/.jetbrains/acp.json"),
                AcpConfiguration.path(Path.of("C:/Users/example"))
        );
    }
}
