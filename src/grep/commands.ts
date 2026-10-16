import { commands, ExtensionContext, window } from 'vscode';
import { toggleFormAndUnit } from './grepEngine';
import { GX_GREP_VIEW_ID, GxGrepViewProvider } from './gxGrepView';

/**
 * Registers the GX Grep panel view and all GX Grep / Form-Unit commands.
 *
 * @param context Extension context
 */
export default function registerGrepCommands(context: ExtensionContext): void {
    const provider = new GxGrepViewProvider(context);

    context.subscriptions.push(
        provider,
        window.registerWebviewViewProvider(GX_GREP_VIEW_ID, provider, {
            webviewOptions: {
                retainContextWhenHidden: true,
            },
        }),
        commands.registerCommand('delphi.gxGrep', async () => {
            await provider.openAndFocus();
        }),
        commands.registerCommand('delphi.gxGrepCurrentUnit', async () => {
            await provider.openAndFocus('current', true);
        }),
        commands.registerCommand('delphi.gxGrepNextMatch', async () => {
            await provider.gotoNextMatch();
        }),
        commands.registerCommand('delphi.gxGrepPrevMatch', async () => {
            await provider.gotoPrevMatch();
        }),
        commands.registerCommand('delphi.toggleFormUnit', async () => {
            await toggleFormAndUnit();
        })
    );
}
