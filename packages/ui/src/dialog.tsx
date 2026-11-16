import { useLayoutEffect } from 'react';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { AlertDialog as BaseAlertDialog } from '@base-ui/react/alert-dialog';
import { holdModalLayer } from './modal-layer.ts';

/**
 * Base UI's dialogs as the app uses them: the same parts, but a dialog's portal
 * holds the modal layer while it is in the page, so the app behind it is inert
 * (`./modal-layer.ts`, #827). Import `Dialog` and `AlertDialog` from here, not
 * from Base UI.
 *
 * The portal is in the page while its dialog is open or closing, and every
 * dialog here is modal (Base UI's default). One given a `container` is drawn
 * inside the app — the peek, over its pane — so it leaves the app alone:
 * making the app inert would make that dialog inert too.
 */
function DialogPortal(props: BaseDialog.Portal.Props) {
  const { children, ...rest } = props;
  return (
    <BaseDialog.Portal {...rest}>
      {props.container === undefined && <ModalLayerHold />}
      {children}
    </BaseDialog.Portal>
  );
}

/** Holds the layer from the moment the portal mounts until it unmounts. */
function ModalLayerHold() {
  useLayoutEffect(() => holdModalLayer(), []);
  return null;
}

export const Dialog = { ...BaseDialog, Portal: DialogPortal };
export const AlertDialog = { ...BaseAlertDialog, Portal: DialogPortal };
