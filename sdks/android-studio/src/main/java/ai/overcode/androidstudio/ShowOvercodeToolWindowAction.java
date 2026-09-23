package ai.overcode.androidstudio;

import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowManager;

public final class ShowOvercodeToolWindowAction extends AnAction {
    @Override
    public void update(AnActionEvent event) {
        event.getPresentation().setEnabledAndVisible(event.getProject() != null);
    }

    @Override
    public void actionPerformed(AnActionEvent event) {
        Project project = event.getProject();
        if (project == null) return;

        ToolWindow toolWindow = ToolWindowManager.getInstance(project).getToolWindow(OvercodeToolWindowFactory.ID);
        if (toolWindow != null) toolWindow.show();
    }
}
