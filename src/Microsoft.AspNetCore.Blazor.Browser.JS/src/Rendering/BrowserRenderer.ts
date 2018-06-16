import { System_Array, MethodHandle } from '../Platform/Platform';
import { getRenderTreeEditPtr, renderTreeEdit, RenderTreeEditPointer, EditType } from './RenderTreeEdit';
import { getTreeFramePtr, renderTreeFrame, FrameType, RenderTreeFramePointer } from './RenderTreeFrame';
import { platform } from '../Environment';
import { EventDelegator } from './EventDelegator';
import { EventForDotNet, UIEventArgs } from './EventForDotNet';
import { LogicalElement, toLogicalElement, insertLogicalChild, removeLogicalChild, getLogicalParent, getLogicalChild, createAndInsertLogicalContainer, isSvgElement } from './LogicalElements';
import { applyCaptureIdToElement } from './ElementReferenceCapture';
const selectValuePropname = '_blazorSelectValue';
let raiseEventMethod: MethodHandle;
let renderComponentMethod: MethodHandle;

export class BrowserRenderer {
  private eventDelegator: EventDelegator;
  private childComponentLocations: { [componentId: number]: LogicalElement } = {};

  constructor(private browserRendererId: number) {
    this.eventDelegator = new EventDelegator((event, componentId, eventHandlerId, eventArgs) => {
      raiseEvent(event, this.browserRendererId, componentId, eventHandlerId, eventArgs);
    });
  }

  public attachRootComponentToElement(componentId: number, element: Element) {
    this.attachComponentToElement(componentId, toLogicalElement(element));
  }

  public updateComponent(componentId: number, edits: System_Array<RenderTreeEditPointer>, editsOffset: number, editsLength: number, referenceFrames: System_Array<RenderTreeFramePointer>) {
    const element = this.childComponentLocations[componentId];
    if (!element) {
      throw new Error(`No element is currently associated with component ${componentId}`);
    }

    this.applyEdits(componentId, element, 0, edits, editsOffset, editsLength, referenceFrames);
  }

  public disposeComponent(componentId: number) {
    delete this.childComponentLocations[componentId];
  }

  public disposeEventHandler(eventHandlerId: number) {
    this.eventDelegator.removeListener(eventHandlerId);
  }

  private attachComponentToElement(componentId: number, element: LogicalElement) {
    this.childComponentLocations[componentId] = element;
  }

  private applyEdits(componentId: number, parent: LogicalElement, childIndex: number, edits: System_Array<RenderTreeEditPointer>, editsOffset: number, editsLength: number, referenceFrames: System_Array<RenderTreeFramePointer>) {
    let currentDepth = 0;
    let childIndexAtCurrentDepth = childIndex;
    const maxEditIndexExcl = editsOffset + editsLength;
    for (let editIndex = editsOffset; editIndex < maxEditIndexExcl; editIndex++) {
      const edit = getRenderTreeEditPtr(edits, editIndex);
      const editType = renderTreeEdit.type(edit);
      switch (editType) {
        case EditType.prependFrame: {
          const frameIndex = renderTreeEdit.newTreeIndex(edit);
          const frame = getTreeFramePtr(referenceFrames, frameIndex);
          const siblingIndex = renderTreeEdit.siblingIndex(edit);
          this.insertFrame(componentId, parent, childIndexAtCurrentDepth + siblingIndex, referenceFrames, frame, frameIndex);
          break;
        }
        case EditType.removeFrame: {
          const siblingIndex = renderTreeEdit.siblingIndex(edit);
          removeLogicalChild(parent, childIndexAtCurrentDepth + siblingIndex);
          break;
        }
        case EditType.setAttribute: {
          const frameIndex = renderTreeEdit.newTreeIndex(edit);
          const frame = getTreeFramePtr(referenceFrames, frameIndex);
          const siblingIndex = renderTreeEdit.siblingIndex(edit);
          const element = getLogicalChild(parent, childIndexAtCurrentDepth + siblingIndex);
          if (element instanceof HTMLElement) {
            this.applyAttribute(componentId, element, frame);
          } else {
            throw new Error(`Cannot set attribute on non-element child`);
          }
          break;
        }
        case EditType.removeAttribute: {
          // Note that we don't have to dispose the info we track about event handlers here, because the
          // disposed event handler IDs are delivered separately (in the 'disposedEventHandlerIds' array)
          const siblingIndex = renderTreeEdit.siblingIndex(edit);
          const element = getLogicalChild(parent, childIndexAtCurrentDepth + siblingIndex);
          if (element instanceof HTMLElement) {
            const attributeName = renderTreeEdit.removedAttributeName(edit)!;
            // First try to remove any special property we use for this attribute
            if (!this.tryApplySpecialProperty(element, attributeName, null)) {
              // If that's not applicable, it's a regular DOM attribute so remove that
              element.removeAttribute(attributeName);
            }
          } else {
            throw new Error(`Cannot remove attribute from non-element child`);
          }
          break;
        }
        case EditType.updateText: {
          const frameIndex = renderTreeEdit.newTreeIndex(edit);
          const frame = getTreeFramePtr(referenceFrames, frameIndex);
          const siblingIndex = renderTreeEdit.siblingIndex(edit);
          const textNode = getLogicalChild(parent, childIndexAtCurrentDepth + siblingIndex);
          if (textNode instanceof Text) {
            textNode.textContent = renderTreeFrame.textContent(frame);
          } else {
            throw new Error(`Cannot set text content on non-text child`);
          }
          break;
        }
        case EditType.stepIn: {
          const siblingIndex = renderTreeEdit.siblingIndex(edit);
          parent = getLogicalChild(parent, childIndexAtCurrentDepth + siblingIndex);
          currentDepth++;
          childIndexAtCurrentDepth = 0;
          break;
        }
        case EditType.stepOut: {
          parent = getLogicalParent(parent)!;
          currentDepth--;
          childIndexAtCurrentDepth = currentDepth === 0 ? childIndex : 0; // The childIndex is only ever nonzero at zero depth
          break;
        }
        default: {
          const unknownType: never = editType; // Compile-time verification that the switch was exhaustive
          throw new Error(`Unknown edit type: ${unknownType}`);
        }
      }
    }
  }

  private insertFrame(componentId: number, parent: LogicalElement, childIndex: number, frames: System_Array<RenderTreeFramePointer>, frame: RenderTreeFramePointer, frameIndex: number): number {
    const frameType = renderTreeFrame.frameType(frame);
    switch (frameType) {
      case FrameType.element:
        this.insertElement(componentId, parent, childIndex, frames, frame, frameIndex);
        return 1;
      case FrameType.text:
        this.insertText(parent, childIndex, frame);
        return 1;
      case FrameType.attribute:
        throw new Error('Attribute frames should only be present as leading children of element frames.');
      case FrameType.component:
        this.insertComponent(parent, childIndex, frame);
        return 1;
      case FrameType.region:
        return this.insertFrameRange(componentId, parent, childIndex, frames, frameIndex + 1, frameIndex + renderTreeFrame.subtreeLength(frame));
      case FrameType.elementReferenceCapture:
        if (parent instanceof Element) {
          applyCaptureIdToElement(parent, renderTreeFrame.elementReferenceCaptureId(frame));
          return 0; // A "capture" is a child in the diff, but has no node in the DOM
        } else {
          throw new Error('Reference capture frames can only be children of element frames.');
        }
      default:
        const unknownType: never = frameType; // Compile-time verification that the switch was exhaustive
        throw new Error(`Unknown frame type: ${unknownType}`);
    }
  }

  private insertElement(componentId: number, parent: LogicalElement, childIndex: number, frames: System_Array<RenderTreeFramePointer>, frame: RenderTreeFramePointer, frameIndex: number) {
    const tagName = renderTreeFrame.elementName(frame)!;
    const newDomElementRaw = tagName === 'svg' || isSvgElement(parent) ?
      document.createElementNS('http://www.w3.org/2000/svg', tagName) :
      document.createElement(tagName);
    const newElement = toLogicalElement(newDomElementRaw);
    insertLogicalChild(newDomElementRaw, parent, childIndex);

    // Apply attributes
    const descendantsEndIndexExcl = frameIndex + renderTreeFrame.subtreeLength(frame);
    for (let descendantIndex = frameIndex + 1; descendantIndex < descendantsEndIndexExcl; descendantIndex++) {
      const descendantFrame = getTreeFramePtr(frames, descendantIndex);
      if (renderTreeFrame.frameType(descendantFrame) === FrameType.attribute) {
        this.applyAttribute(componentId, newDomElementRaw, descendantFrame);
      } else {
        // As soon as we see a non-attribute child, all the subsequent child frames are
        // not attributes, so bail out and insert the remnants recursively
        this.insertFrameRange(componentId, newElement, 0, frames, descendantIndex, descendantsEndIndexExcl);
        break;
      }
    }
  }

  private insertComponent(parent: LogicalElement, childIndex: number, frame: RenderTreeFramePointer) {
    const containerElement = createAndInsertLogicalContainer(parent, childIndex);

    // All we have to do is associate the child component ID with its location. We don't actually
    // do any rendering here, because the diff for the child will appear later in the render batch.
    const childComponentId = renderTreeFrame.componentId(frame);
    this.attachComponentToElement(childComponentId, containerElement);
  }

  private insertText(parent: LogicalElement, childIndex: number, textFrame: RenderTreeFramePointer) {
    const textContent = renderTreeFrame.textContent(textFrame)!;
    const newTextNode = document.createTextNode(textContent);
    insertLogicalChild(newTextNode, parent, childIndex);
  }

  private applyAttribute(componentId: number, toDomElement: Element, attributeFrame: RenderTreeFramePointer) {
    const attributeName = renderTreeFrame.attributeName(attributeFrame)!;
    const browserRendererId = this.browserRendererId;
    const eventHandlerId = renderTreeFrame.attributeEventHandlerId(attributeFrame);

    if (eventHandlerId) {
      const firstTwoChars = attributeName.substring(0, 2);
      const eventName = attributeName.substring(2);
      if (firstTwoChars !== 'on' || !eventName) {
        throw new Error(`Attribute has nonzero event handler ID, but attribute name '${attributeName}' does not start with 'on'.`);
      }
      this.eventDelegator.setListener(toDomElement, eventName, componentId, eventHandlerId);
      return;
    }

    // First see if we have special handling for this attribute
    if (!this.tryApplySpecialProperty(toDomElement, attributeName, attributeFrame)) {
      // If not, treat it as a regular string-valued attribute
      toDomElement.setAttribute(
        attributeName,
        renderTreeFrame.attributeValue(attributeFrame)!
      );
    }
  }

  private tryApplySpecialProperty(element: Element, attributeName: string, attributeFrame: RenderTreeFramePointer | null) {
    switch (attributeName) {
      case 'value':
        return this.tryApplyValueProperty(element, attributeFrame);
      case 'checked':
        return this.tryApplyCheckedProperty(element, attributeFrame);
      default:
        return false;
    }
  }

  private tryApplyValueProperty(element: Element, attributeFrame: RenderTreeFramePointer | null) {
    // Certain elements have built-in behaviour for their 'value' property
    switch (element.tagName) {
      case 'INPUT':
      case 'SELECT':
      case 'TEXTAREA': {
        const value = attributeFrame ? renderTreeFrame.attributeValue(attributeFrame) : null;
        (element as any).value = value;

        if (element.tagName === 'SELECT') {
          // <select> is special, in that anything we write to .value will be lost if there
          // isn't yet a matching <option>. To maintain the expected behavior no matter the
          // element insertion/update order, preserve the desired value separately so
          // we can recover it when inserting any matching <option>.
          element[selectValuePropname] = value;
        }
        return true;
      }
      case 'OPTION': {
        const value = attributeFrame ? renderTreeFrame.attributeValue(attributeFrame) : null;
        if (value) {
          element.setAttribute('value', value);
        } else {
          element.removeAttribute('value');
        }
        // See above for why we have this special handling for <select>/<option>
        const parentElement = element.parentElement;
        if (parentElement && (selectValuePropname in parentElement) && parentElement[selectValuePropname] === value) {
          this.tryApplyValueProperty(parentElement, attributeFrame);
          delete parentElement[selectValuePropname];
        }
        return true;
      }
      default:
        return false;
    }
  }

  private tryApplyCheckedProperty(element: Element, attributeFrame: RenderTreeFramePointer | null) {
    // Certain elements have built-in behaviour for their 'checked' property
    if (element.tagName === 'INPUT') {
      const value = attributeFrame ? renderTreeFrame.attributeValue(attributeFrame) : null;
      (element as any).checked = value !== null;
      return true;
    } else {
      return false;
    }
  }

  private insertFrameRange(componentId: number, parent: LogicalElement, childIndex: number, frames: System_Array<RenderTreeFramePointer>, startIndex: number, endIndexExcl: number): number {
    const origChildIndex = childIndex;
    for (let index = startIndex; index < endIndexExcl; index++) {
      const frame = getTreeFramePtr(frames, index);
      const numChildrenInserted = this.insertFrame(componentId, parent, childIndex, frames, frame, index);
      childIndex += numChildrenInserted;

      // Skip over any descendants, since they are already dealt with recursively
      index += countDescendantFrames(frame);
    }

    return (childIndex - origChildIndex); // Total number of children inserted
  }
}

function countDescendantFrames(frame: RenderTreeFramePointer): number {
  switch (renderTreeFrame.frameType(frame)) {
    // The following frame types have a subtree length. Other frames may use that memory slot
    // to mean something else, so we must not read it. We should consider having nominal subtypes
    // of RenderTreeFramePointer that prevent access to non-applicable fields.
    case FrameType.component:
    case FrameType.element:
    case FrameType.region:
      return renderTreeFrame.subtreeLength(frame) - 1;
    default:
      return 0;
  }
}

function raiseEvent(event: Event, browserRendererId: number, componentId: number, eventHandlerId: number, eventArgs: EventForDotNet<UIEventArgs>) {
  if (!raiseEventMethod) {
    raiseEventMethod = platform.findMethod(
      'Microsoft.AspNetCore.Blazor.Browser', 'Microsoft.AspNetCore.Blazor.Browser.Rendering', 'BrowserRendererEventDispatcher', 'DispatchEvent'
    );
  }

  const eventDescriptor = {
    browserRendererId,
    componentId,
    eventHandlerId,
    eventArgsType: eventArgs.type
  };

  platform.callMethod(raiseEventMethod, null, [
    platform.toDotNetString(JSON.stringify(eventDescriptor)),
    platform.toDotNetString(JSON.stringify(eventArgs.data))
  ]);
}
