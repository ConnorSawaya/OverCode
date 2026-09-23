package ai.overcode.androidstudio;

import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowFactory;
import com.intellij.ui.components.JBLabel;
import com.intellij.ui.components.JBTextArea;
import com.intellij.util.ui.JBUI;

import javax.swing.JButton;
import javax.swing.JPanel;
import java.awt.BorderLayout;
import java.awt.FlowLayout;
import java.awt.Toolkit;
import java.awt.datatransfer.StringSelection;

public final class OvercodeToolWindowFactory implements ToolWindowFactory {
    public static final String ID = "Overcode";

    @Override
    public void createToolWindowContent(Project project, ToolWindow toolWindow) {
        JPanel root = new JPanel(new BorderLayout(0, JBUI.scale(10)));
        root.setBorder(JBUI.Borders.empty(12));

        JBLabel title = new JBLabel("Overcode for Android Studio");
        title.setFont(title.getFont().deriveFont(title.getFont().getSize2D() + 2f));
        root.add(title, BorderLayout.NORTH);

        JBTextArea description = new JBTextArea(
                "Use Overcode through Android Studio's AI Assistant agent selector. "
                        + "Goal loops, goal_control, and queued messages stay in Overcode, so this plugin does not duplicate "
                        + "chat prompts or project-specific code generators."
        );
        description.setEditable(false);
        description.setLineWrap(true);
        description.setWrapStyleWord(true);
        description.setBackground(root.getBackground());
        description.setBorder(JBUI.Borders.empty());

        JPanel details = new JPanel(new BorderLayout(0, JBUI.scale(8)));
        details.add(description, BorderLayout.NORTH);
        details.add(new JBLabel("Project: " + project.getBasePath()), BorderLayout.CENTER);
        root.add(details, BorderLayout.CENTER);

        JPanel actions = new JPanel(new FlowLayout(FlowLayout.LEFT, JBUI.scale(6), 0));
        JButton install = new JButton("Install ACP config");
        install.addActionListener(event -> InstallOvercodeAcpAction.install(project));

        JButton copy = new JButton("Copy config");
        copy.addActionListener(event -> Toolkit.getDefaultToolkit().getSystemClipboard().setContents(
                new StringSelection(AcpConfiguration.render("overcode")), null
        ));

        actions.add(install);
        actions.add(copy);
        root.add(actions, BorderLayout.SOUTH);

        toolWindow.getContentManager().addContent(
                com.intellij.ui.content.ContentFactory.getInstance().createContent(root, "", false)
        );
    }
}
