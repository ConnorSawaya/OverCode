package ai.overcode.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(OvercodeUpdaterPlugin.class);
        registerPlugin(OvercodeSecureStoragePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
