package ai.overcode.androidstudio;

import com.intellij.notification.NotificationGroupManager;
import com.intellij.notification.NotificationType;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.project.Project;

import java.awt.Toolkit;
import java.awt.datatransfer.StringSelection;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

public final class InstallOvercodeAcpAction extends AnAction {
    @Override
    public void actionPerformed(AnActionEvent event) {
        install(event.getProject());
    }

    public static void install(Project project) {
        Path config = AcpConfiguration.path(Path.of(System.getProperty("user.home")));
        String content = AcpConfiguration.render("overcode");

        try {
            if (Files.exists(config)) {
                String existing = Files.readString(config, StandardCharsets.UTF_8);
                if (AcpConfiguration.containsOvercodeAgent(existing)) {
                    notify(project, "Overcode is already present in " + config, NotificationType.INFORMATION);
                    return;
                }

                copyToClipboard(content);
                notify(
                        project,
                        "Existing ACP configuration was preserved. The Overcode entry was copied to the clipboard for merging.",
                        NotificationType.INFORMATION
                );
                return;
            }

            Files.createDirectories(config.getParent());
            Files.writeString(config, content, StandardCharsets.UTF_8);
            notify(project, "Installed Overcode ACP configuration at " + config, NotificationType.INFORMATION);
        } catch (IOException error) {
            copyToClipboard(content);
            notify(
                    project,
                    "Could not write " + config + ". The configuration was copied to the clipboard instead.",
                    NotificationType.ERROR
            );
        }
    }

    private static void copyToClipboard(String content) {
        Toolkit.getDefaultToolkit().getSystemClipboard().setContents(new StringSelection(content), null);
    }

    private static void notify(Project project, String message, NotificationType type) {
        NotificationGroupManager.getInstance()
                .getNotificationGroup("Overcode")
                .createNotification(message, type)
                .notify(project);
    }
}
