package ai.overcode.mobile;

import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(OvercodeUpdaterPlugin.class);
        registerPlugin(OvercodeSecureStoragePlugin.class);
        super.onCreate(savedInstanceState);
        // Keep the screen on while the app is open so sessions never sleep.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }
}
