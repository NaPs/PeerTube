import { Component, Input } from '@angular/core'
import { GlobalIconName } from '@app/shared/images/global-icon.component'

export type DropdownAction<T> = {
  label?: string
  iconName?: GlobalIconName
  handler?: (a: T) => any
  linkBuilder?: (a: T) => (string | number)[]
  isDisplayed?: (a: T) => boolean
}

export type DropdownButtonSize = 'normal' | 'small'
export type DropdownTheme = 'orange' | 'grey'
export type DropdownDirection = 'horizontal' | 'vertical'

@Component({
  selector: 'my-action-dropdown',
  styleUrls: [ './action-dropdown.component.scss' ],
  templateUrl: './action-dropdown.component.html'
})

export class ActionDropdownComponent<T> {
  @Input() actions: DropdownAction<T>[] | DropdownAction<T>[][] = []
  @Input() entry: T

  @Input() placement = 'bottom-left'

  @Input() buttonSize: DropdownButtonSize = 'normal'
  @Input() buttonDirection: DropdownDirection = 'horizontal'
  @Input() buttonStyled = true

  @Input() label: string
  @Input() theme: DropdownTheme = 'grey'

  getActions () {
    if (this.actions.length !== 0 && Array.isArray(this.actions[0])) return this.actions

    return [ this.actions ]
  }

  areActionsDisplayed (actions: DropdownAction<T>[], entry: T) {
    return actions.some(a => a.isDisplayed === undefined || a.isDisplayed(entry))
  }

  handleClick (event: Event, action: DropdownAction<T>) {
    event.preventDefault()

    // action.handler(entry)
  }
}
